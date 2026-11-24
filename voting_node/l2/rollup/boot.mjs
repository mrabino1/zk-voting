// NOT FOR PROFIT — civic public good, not a commercial product.
// Start the L2 HTTP server before any L1 or rollup init. With L2_ALLOW_DEGRADED
// unset, empty, or false, a failed startup check exits (fail-fast). With it on,
// the process stays up, serves /health as degraded, and retries init. It does
// not batch, prove, or submit to L1 until init succeeds.

import { createRequire } from 'node:module';

import { redactL1RpcAuth, scrubL1RpcAuthError } from '../l1RpcAuth.js';
import { createApi } from './server.mjs';

// l1.mjs (viem) and operator.mjs load on first use, after the server listens. A module
// that fails to load is then an init failure (degraded or fail-fast with its reason),
// not a crash before /health exists.
const loadL1 = () => import('./l1.mjs');
const loadOperator = () => import('./operator.mjs');

const require = createRequire(import.meta.url);
const { assertKeyAllowedOnChain, readDeployment } = require('../../packages/chain-client/index.js');

const SECRET_ENV = ['OPERATOR_PRIVATE_KEY', 'ROLLUP_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'L2_BALLOT_TOKEN', 'L1_RPC_AUTH_TOKEN'];

/** Empty, false, 0, and off keep today's fail-fast start. 1, true, yes, and on stay up. */
export function allowDegraded(env = process.env) {
  const value = String(env?.L2_ALLOW_DEGRADED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** 2s, 4s, 8s, 16s, then 30s. */
export function retryDelayMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30_000, 2000 * 2 ** Math.min(n, 4));
}

export function safeReason(reason) {
  const text = String(reason || '');
  return /^[a-z][a-z0-9_]{0,63}$/.test(text) ? text : 'rollup_init_failed';
}

function fail(message, reason) {
  const err = new Error(message);
  err.reason = safeReason(reason);
  return err;
}

/**
 * Redact operator secrets and credentialed RPC URLs. Uses the existing L1
 * token helper, then strips known keys and userinfo / query credentials.
 */
export function redactOperatorLog(text, env = process.env) {
  let out = redactL1RpcAuth(text, env);
  const rpc = String(env?.L1_RPC || '').trim();
  if (rpc && (rpc.includes('@') || /[?&](?:token|key|apikey|api_key|auth|password|secret)=/i.test(rpc))) {
    out = out.split(rpc).join('[redacted-rpc]');
  }
  for (const name of SECRET_ENV) {
    const secret = String(env?.[name] || '').trim();
    if (secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
    if (secret.startsWith('0x') && secret.length > 8) out = out.split(secret.slice(2)).join('[redacted]');
  }
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
  out = out.replace(/([?&](?:token|key|apikey|api_key|auth|password|secret|access_token)=)[^&\s#]+/gi, '$1[redacted]');
  return out;
}

function loggedMessage(err, env) {
  try {
    scrubL1RpcAuthError(err, env);
  } catch {
    /* keep the original text */
  }
  return redactOperatorLog(err?.message || 'L2 startup failed', env);
}

export function normalizeFailure(err) {
  const message = err?.message || 'L2 startup failed';
  if (err?.reason) return { reason: safeReason(err.reason), message };
  if (/rollup genesis not found/i.test(message)) return { reason: 'genesis_not_found', message };
  if (/no batch prover/i.test(message)) return { reason: 'no_batch_prover', message };
  if (/OPERATOR_PRIVATE_KEY is required/i.test(message)) return { reason: 'missing_operator_key', message };
  if (/not a usable private key|Anvil dev key/i.test(message)) return { reason: 'unusable_operator_key', message };
  if (/ROLLUP_ADDRESS is required/i.test(message)) return { reason: 'missing_rollup_address', message };
  if (/not a usable address/i.test(message)) return { reason: 'unusable_rollup_address', message };
  if (/does not exist yet/i.test(message)) return { reason: 'deployment_file_missing', message };
  if (/deployment record/i.test(message)) return { reason: 'deployment_file_unreadable', message };
  if (/L1_RPC is required/i.test(message)) return { reason: 'missing_l1_rpc', message };
  if (/chain id|L1_CHAIN_ID/i.test(message)) return { reason: 'l1_chain_id', message };
  if (/ZK_VOTING_ALLOW_MOCK_PROOFS/i.test(message)) return { reason: 'mock_proofs_refused', message };
  if (/L1 genesis root/i.test(message)) return { reason: 'genesis_mismatch', message };
  return { reason: 'rollup_init_failed', message };
}

function usableKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const hex = text.startsWith('0x') ? text : `0x${text}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : '';
}

function usableAddress(raw) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(raw || '').trim());
}

/**
 * Run the startup checks that used to happen before listen. Throws an Error
 * with `.reason` set to a short code. Does not submit transactions.
 */
export async function initOperator(env, deps) {
  if (!env.L1_RPC) throw fail('L1_RPC is required', 'missing_l1_rpc');

  let deployment = null;
  if (env.ROLLUP_DEPLOYMENT_FILE) {
    try {
      deployment = deps.readDeployment(env.ROLLUP_DEPLOYMENT_FILE);
    } catch (err) {
      throw fail(err.message || 'cannot read the rollup deployment file', 'deployment_file_unreadable');
    }
    if (!deployment) {
      throw fail(`ROLLUP_DEPLOYMENT_FILE ${env.ROLLUP_DEPLOYMENT_FILE} does not exist yet`, 'deployment_file_missing');
    }
  }
  if (!env.ROLLUP_ADDRESS && deployment?.rollup) env.ROLLUP_ADDRESS = deployment.rollup;
  if (!env.ROLLUP_ADDRESS) throw fail('ROLLUP_ADDRESS is required', 'missing_rollup_address');
  if (!usableAddress(env.ROLLUP_ADDRESS)) throw fail('ROLLUP_ADDRESS is not a usable address', 'unusable_rollup_address');

  if (!String(env.OPERATOR_PRIVATE_KEY || '').trim()) throw fail('OPERATOR_PRIVATE_KEY is required', 'missing_operator_key');
  const privateKey = usableKey(env.OPERATOR_PRIVATE_KEY);
  if (!privateKey) throw fail('OPERATOR_PRIVATE_KEY is not a usable private key', 'unusable_operator_key');

  const configured = String(env.L1_CHAIN_ID || '').trim();
  let chainId;
  if (configured) {
    chainId = Number(configured);
    if (!Number.isInteger(chainId) || chainId <= 0) throw fail('L1_CHAIN_ID is not a usable chain id', 'l1_chain_id');
    let actual;
    try {
      actual = Number(await deps.readL1ChainId(env.L1_RPC, env));
    } catch (err) {
      throw fail(err.message || 'L1 chain id check failed', 'l1_chain_id');
    }
    if (!Number.isInteger(actual) || actual !== chainId) {
      throw fail(`L1 RPC serves chain ${actual}, but L1_CHAIN_ID is ${chainId}`, 'l1_chain_id');
    }
  } else {
    try {
      chainId = Number(await deps.readL1ChainId(env.L1_RPC, env));
    } catch (err) {
      throw fail(err.message || 'L1 chain id check failed', 'l1_chain_id');
    }
    if (!Number.isInteger(chainId) || chainId <= 0) throw fail('L1 chain id check failed', 'l1_chain_id');
  }

  try {
    deps.assertKeyAllowedOnChain(privateKey, chainId, 'OPERATOR_PRIVATE_KEY');
  } catch (err) {
    throw fail(err.message, 'unusable_operator_key');
  }

  const allowMockProofs = env.ZK_VOTING_ALLOW_MOCK_PROOFS === '1';
  if (allowMockProofs && chainId !== 31337) {
    throw fail('ZK_VOTING_ALLOW_MOCK_PROOFS is for chain 31337 only', 'mock_proofs_refused');
  }

  const l1 = await deps.createL1({ rpcUrl: env.L1_RPC, chainId, rollup: env.ROLLUP_ADDRESS, privateKey, env });
  let operator;
  try {
    operator = await (
      await deps.createOperator({
        l1,
        chainId,
        dataDir: env.L2_DATA_DIR || './data',
        allowMockProofs,
        batchMaxWaitSeconds:
          env.L2_BATCH_MAX_WAIT_SECONDS != null && env.L2_BATCH_MAX_WAIT_SECONDS !== ''
            ? Number(env.L2_BATCH_MAX_WAIT_SECONDS)
            : chainId === 31337
              ? 0
              : 600,
      })
    ).init();
  } catch (err) {
    const mapped = normalizeFailure(err);
    throw fail(mapped.message, mapped.reason);
  }
  if (!operator) throw fail('rollup init returned no operator', 'rollup_init_failed');

  let mock = false;
  try {
    mock = await l1.isMockVerifier();
  } catch (err) {
    throw fail(err.message || 'batch verifier check failed', 'rollup_init_failed');
  }
  if (!mock) {
    throw fail('This operator has no batch prover yet; it can only settle against MockBatchVerifier.', 'no_batch_prover');
  }
  return { operator, l1, chainId };
}

function healthBody(runtime) {
  if (runtime.mode === 'ready' && runtime.operator) {
    return { ok: true, status: 'ok', ...runtime.operator.status() };
  }
  if (runtime.mode === 'degraded') {
    return { ok: true, status: 'degraded', reason: safeReason(runtime.reason) };
  }
  return { ok: true, status: 'starting', reason: null };
}

function defaultLog() {
  return {
    info: (...parts) => console.log(...parts),
    warn: (...parts) => console.warn(...parts),
    error: (...parts) => console.error(...parts),
  };
}

function defaultDeps(env, log) {
  return {
    readDeployment,
    assertKeyAllowedOnChain,
    readL1ChainId: async (...args) => (await loadL1()).readL1ChainId(...args),
    createL1: async (opts) => (await loadL1()).createL1(opts),
    createOperator: async (opts) =>
      new (await loadOperator()).Operator({
        ...opts,
        log: (...parts) => {
          const text = parts
            .map((part) => (typeof part === 'string' ? redactOperatorLog(part, env) : String(part)))
            .join(' ');
          log.info(new Date().toISOString(), text);
        },
      }),
    retryDelayMs,
  };
}

async function cancellableSleep(ms, runtime) {
  if (runtime.stopped) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      runtime.sleepCancel = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (typeof timer.unref === 'function') timer.unref();
    runtime.sleepCancel = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

function armBatch(runtime, env, deps, log) {
  if (runtime.batchTimer || runtime.stopped) return;
  const ms = deps.batchIntervalMs ?? Math.max(1000, Number(env.L2_BATCH_SECONDS || 10) * 1000);
  const timer = setInterval(() => {
    const op = runtime.operator;
    if (runtime.stopped || runtime.mode !== 'ready' || !op) return;
    Promise.resolve(op.tick()).catch((err) => {
      log.error(`batch failed: ${redactOperatorLog(err?.shortMessage || err?.message || 'batch failed', env)}`);
    });
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  runtime.batchTimer = timer;
}

/**
 * Listen first, then initialize. `onListening` runs after the port accepts
 * connections and before Operator.init or any L1 read.
 *
 * @returns {Promise<{ url: string, server: import('node:http').Server, close: () => Promise<void>, done: Promise<void> }>}
 */
export async function startOperator(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || defaultLog();
  const deps = { ...defaultDeps(env, log), ...opts.deps };
  const allow = allowDegraded(env);
  const runtime = {
    mode: 'starting',
    reason: null,
    operator: null,
    l1: null,
    stopped: false,
    warnedReason: null,
    batchTimer: null,
    sleepCancel: null,
  };

  const host = opts.host || env.L2_RPC_HOST || '127.0.0.1';
  const port = opts.port ?? Number(env.L2_RPC_PORT || 8546);
  const server = createApi(null, {
    ballotToken: env.L2_BALLOT_TOKEN,
    gate: {
      health: () => healthBody(runtime),
      operator: () => (runtime.mode === 'ready' ? runtime.operator : null),
    },
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  let closed = false;
  const closeServer = () => {
    if (closed) return Promise.resolve();
    closed = true;
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  const handle = {
    server,
    url: `http://${urlHost}:${boundPort}`,
    runtime,
    done,
    close: async () => {
      runtime.stopped = true;
      if (runtime.sleepCancel) runtime.sleepCancel();
      if (runtime.batchTimer) clearInterval(runtime.batchTimer);
      runtime.batchTimer = null;
      await closeServer();
    },
  };

  const exit = opts.exit || ((code) => process.exit(code));

  const failFast = async (failure) => {
    runtime.stopped = true;
    log.error(loggedMessage(fail(failure.message, failure.reason), env));
    if (runtime.batchTimer) clearInterval(runtime.batchTimer);
    runtime.batchTimer = null;
    await closeServer();
    exit(2);
  };

  const enterDegraded = (failure) => {
    const reason = safeReason(failure.reason);
    const changed = runtime.mode !== 'degraded' || runtime.warnedReason !== reason;
    runtime.mode = 'degraded';
    runtime.reason = reason;
    runtime.operator = null;
    runtime.l1 = null;
    if (!changed) return;
    runtime.warnedReason = reason;
    log.warn(`L2 degraded (${reason}): ${loggedMessage(fail(failure.message, reason), env)}`);
  };

  async function runLoop() {
    let attempt = 0;
    while (!runtime.stopped) {
      try {
        const ready = await initOperator(env, deps);
        if (runtime.stopped) return;
        runtime.operator = ready.operator;
        runtime.l1 = ready.l1;
        runtime.mode = 'ready';
        runtime.reason = null;
        log.info(`L2 operator for ${ready.l1?.address || env.ROLLUP_ADDRESS} ready`);
        armBatch(runtime, env, deps, log);
        return;
      } catch (err) {
        if (runtime.stopped) return;
        const failure = normalizeFailure(err);
        if (!allow) {
          await failFast(failure);
          return;
        }
        enterDegraded(failure);
        const delay = (deps.retryDelayMs || retryDelayMs)(attempt);
        attempt += 1;
        if (deps.sleep) await deps.sleep(delay);
        else await cancellableSleep(delay, runtime);
      }
    }
  }

  log.info(`L2 operator listening on ${handle.url}`);
  if (opts.onListening) {
    try {
      await opts.onListening(handle);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  runLoop()
    .catch((err) => {
      log.error(loggedMessage(err, env));
      if (!allow && !runtime.stopped) exit(2);
    })
    .finally(() => resolveDone());

  return handle;
}

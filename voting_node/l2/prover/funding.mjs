// NOT FOR PROFIT — civic public good, not a commercial product.
// L1 submitter funding check. The L2 operator pays L1 gas for vote batches;
// voters never pay. The key needs a little ETH, not a lot.
//
// Levels:
//   ok     balance covers L1_SUBMITTER_MIN_BATCHES batches at the current gas price
//   low    balance covers at least one batch but fewer than the minimum: warn
//   empty  balance cannot pay for one batch: the prover holds batches (fail closed)

export const DEFAULT_GAS_PER_BATCH = 250_000n;
export const DEFAULT_MIN_BATCHES = 20n;

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  return json.result;
}

export function formatEth(wei) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac} ETH`;
}

export function assessFunding({ balanceWei, gasPriceWei, gasPerBatch = DEFAULT_GAS_PER_BATCH, minBatches = DEFAULT_MIN_BATCHES }) {
  const balance = BigInt(balanceWei);
  const perBatch = BigInt(gasPriceWei) * BigInt(gasPerBatch);
  const target = perBatch * BigInt(minBatches);
  const batchesLeft = perBatch > 0n ? balance / perBatch : null;
  let level = 'ok';
  if (perBatch > 0n && balance < perBatch) level = 'empty';
  else if (balance < target) level = 'low';
  if (balance === 0n) level = 'empty';
  const message =
    level === 'ok'
      ? `L1 submitter funded: ${formatEth(balance)} (~${batchesLeft} batches)`
      : level === 'low'
        ? `L1 submitter balance is low: ${formatEth(balance)} covers ~${batchesLeft} batches; top up to at least ${formatEth(target)}`
        : `L1 submitter cannot pay for a batch: ${formatEth(balance)}; needs at least ${formatEth(perBatch)} at the current gas price`;
  return {
    level,
    ok: level !== 'empty',
    balanceWei: balance.toString(),
    gasPriceWei: BigInt(gasPriceWei).toString(),
    perBatchWei: perBatch.toString(),
    targetWei: target.toString(),
    batchesLeft: batchesLeft == null ? null : Number(batchesLeft),
    message,
  };
}

export async function checkSubmitterFunding({
  l1Rpc,
  address,
  fetchImpl = fetch,
  gasPerBatch = BigInt(process.env.L1_SUBMITTER_GAS_PER_BATCH || DEFAULT_GAS_PER_BATCH),
  minBatches = BigInt(process.env.L1_SUBMITTER_MIN_BATCHES || DEFAULT_MIN_BATCHES),
} = {}) {
  if (!l1Rpc) return { level: 'unconfigured', ok: false, message: 'L1_RPC is not set' };
  if (!address) {
    return { level: 'unconfigured', ok: false, message: 'L1_SUBMITTER_PRIVATE_KEY is not set (or not a valid key)' };
  }
  try {
    const [bal, gp] = await Promise.all([
      rpc(l1Rpc, 'eth_getBalance', [address, 'latest'], fetchImpl),
      rpc(l1Rpc, 'eth_gasPrice', [], fetchImpl),
    ]);
    return { address, ...assessFunding({ balanceWei: BigInt(bal), gasPriceWei: BigInt(gp), gasPerBatch, minBatches }) };
  } catch (err) {
    return { level: 'unreachable', ok: false, address, message: `L1 RPC error: ${err.message || err}` };
  }
}

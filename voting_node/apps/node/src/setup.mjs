// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup: the platform super admin and the chain id.
//
// Chain id has ONE accessor: `config.chainId`. `installChainIdAccessor` turns
// it into a getter that resolves, in order:
//   1. CHAIN_ID from the environment (or the `chainId` override in tests),
//   2. the value chosen on the first-run setup screen (store meta.setup.chainId),
//   3. the civic L2 default 27427.
// The environment always wins. Compose and the L2 sequencer read the same
// CHAIN_ID variable (docker-compose.yml maps it to L2_CHAIN_ID).

export const DEFAULT_CHAIN_ID = 27427;
export const MAX_CHAIN_ID = 2 ** 53 - 1;

export const CHAIN_ID_PRESETS = Object.freeze([
  Object.freeze({ chainId: 27427, label: 'Civic L2 (default)' }),
  Object.freeze({ chainId: 1, label: 'Ethereum mainnet' }),
  Object.freeze({ chainId: 11155111, label: 'Sepolia testnet' }),
  Object.freeze({ chainId: 31337, label: 'Local (Anvil / Hardhat)' }),
]);

/**
 * Parse a chain id. Accepts a positive safe integer (number or decimal
 * string). Returns null for anything else.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseChainId(value) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CHAIN_ID) return null;
  return n;
}

/**
 * Resolve the deploy-time CHAIN_ID. Empty or unset means "not fixed by the
 * environment". A set but invalid value refuses to start.
 * @param {unknown} value
 * @returns {number|null}
 */
export function resolveEnvChainId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = parseChainId(value);
  if (n === null) {
    throw new Error('CHAIN_ID is set but is not a positive integer. Refusing to start.');
  }
  return n;
}

export function setupMeta(store) {
  store.data.meta = store.data.meta || {};
  const meta = store.data.meta;
  if (!meta.setup || typeof meta.setup !== 'object') meta.setup = {};
  return meta.setup;
}

/** Read-only view of the stored setup record (never creates it). */
export function readSetup(store) {
  const setup = store?.data?.meta?.setup;
  return setup && typeof setup === 'object' ? setup : {};
}

/**
 * Where the effective chain id comes from.
 * @returns {{ chainId: number, source: 'env'|'setup'|'default', fixed: boolean }}
 */
export function chainIdInfo(config, store) {
  const envId = config.chainIdEnv ?? null;
  if (envId != null) return { chainId: envId, source: 'env', fixed: true };
  const stored = parseChainId(readSetup(store).chainId);
  if (stored != null) return { chainId: stored, source: 'setup', fixed: false };
  return { chainId: DEFAULT_CHAIN_ID, source: 'default', fixed: false };
}

/**
 * Make `config.chainId` a live getter so every existing reader picks up the
 * setup choice. Assigning `config.chainId = n` (tests, scripts) pins it like
 * an environment value.
 */
export function installChainIdAccessor(config, store) {
  Object.defineProperty(config, 'chainId', {
    configurable: true,
    enumerable: true,
    get() {
      return chainIdInfo(config, store).chainId;
    },
    set(value) {
      const n = parseChainId(value);
      config.chainIdEnv = n;
    },
  });
  return config;
}

/** Handles a first-run admin may pick: 2–32 of [A-Za-z0-9._-], starting alnum. */
export const ADMIN_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

/**
 * The super admin row that has no sign-in factor yet (the ADMIN_HANDLE seed),
 * or null.
 */
export function unclaimedSuperAdmin(store, isClaimedPerson) {
  return (
    store.data.users.find((u) => u && u.is_deleted !== true && u.role === 'platform_super_admin' && !isClaimedPerson(u)) || null
  );
}

/** True once any platform super admin holds a sign-in factor. */
export function hasClaimedSuperAdmin(store, isClaimedPerson) {
  return store.data.users.some((u) => u && u.is_deleted !== true && u.role === 'platform_super_admin' && isClaimedPerson(u));
}

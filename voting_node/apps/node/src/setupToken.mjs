// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup token. A value from the environment is used as-is.
// When that value is empty, the process mints a one-time token. The token
// is printed only to the process log and is never placed on an HTTP response.

import { randomBytes } from 'node:crypto';

/**
 * @param {unknown} raw
 * @returns {{ setupToken: string, setupTokenGenerated: boolean }}
 */
export function resolveSetupToken(raw) {
  const configured = String(raw ?? '').trim();
  if (configured) return { setupToken: configured, setupTokenGenerated: false };
  return { setupToken: randomBytes(32).toString('base64url'), setupTokenGenerated: true };
}

/**
 * Print a generated token once, to the process log only.
 * Quiet processes (the test runner) do not print it.
 * @param {{ setupToken?: string, setupTokenGenerated?: boolean, quiet?: boolean }} config
 * @param {(line: string) => void} [write]
 * @returns {boolean}
 */
export function announceGeneratedSetupToken(config, write = defaultWrite) {
  if (!config?.setupTokenGenerated || config.quiet || !config.setupToken) return false;
  write(
    '[zk-voting] SETUP_TOKEN is unset. A one-time setup token was generated for this process.\n' +
      '[zk-voting] Type it on /setup. It is not available over HTTP. Restarting before the super admin is created replaces it.\n' +
      `[zk-voting] setup-token ${config.setupToken}\n`,
  );
  return true;
}

function defaultWrite(line) {
  process.stdout.write(line);
}

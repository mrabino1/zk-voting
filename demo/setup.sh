#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
# Guided clone-and-launch setup. Asks six short questions, writes demo/.env,
# and prints the exact launch command. Safe to re-run: your answers are the
# defaults and secrets are never printed. Options: ./setup.sh --help
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "setup: Node.js 20 or newer is needed (https://nodejs.org). Docker alone can run the app; setup needs Node once." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 20 )); then
  echo "setup: Node.js 20 or newer is needed (found $(node -v))." >&2
  exit 1
fi
if [[ ! -d "$DIR/node_modules/viem" ]]; then
  echo "setup: installing demo dependencies once (npm install) so the L1 key can be turned into an address..." >&2
  (cd "$DIR" && npm install --no-audit --no-fund >/dev/null) || echo "setup: npm install failed; continuing (you can type the operator address instead)." >&2
fi
exec node "$DIR/tools/setup/setup.mjs" "$@"

#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "Anvil is not running at ${RPC_URL}." >&2
  echo "Start it with: anvil" >&2
  echo "Then re-run $0" >&2
  exit 1
fi

exec forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  -vvv

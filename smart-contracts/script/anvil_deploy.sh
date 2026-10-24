#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
# LOCAL-ONLY: Anvil's public, well-known dev account #0 key. It is published
# in Foundry's docs, holds nothing of value, and is used only when PRIVATE_KEY
# is unset AND the RPC reports Anvil's chain id 31337. Never use it elsewhere.
ANVIL_PUBLIC_DEV_KEY_LOCAL_ONLY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

if ! CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)"; then
  echo "Anvil is not running at ${RPC_URL}." >&2
  echo "Start it with: anvil" >&2
  echo "Then re-run $0" >&2
  exit 1
fi

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  if [[ "$CHAIN_ID" != "31337" ]]; then
    echo "PRIVATE_KEY is not set and ${RPC_URL} is chain ${CHAIN_ID}, not local Anvil (31337)." >&2
    echo "Set PRIVATE_KEY in the environment; the Anvil dev key is local-only." >&2
    exit 1
  fi
  echo "PRIVATE_KEY not set: using Anvil's public dev key (LOCAL ONLY, chain 31337)." >&2
  PRIVATE_KEY="$ANVIL_PUBLIC_DEV_KEY_LOCAL_ONLY"
fi

exec forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  -vvv

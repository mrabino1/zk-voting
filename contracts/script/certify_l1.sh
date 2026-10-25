#!/usr/bin/env bash
# certify_l1.sh — post a Node/L2 tally hash to L1TallyMirror (testnet / Anvil).
#
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Graceful no-op when L1_RPC, TALLY_MIRROR / L1_TALLY_MIRROR_ADDRESS, or
# L1_PUBLISHER_PRIVATE_KEY are unset. Does not read the L2 prover PRIVATE_KEY.
# Never pass a mainnet key in CI.
#
# Required when posting:
#   L1_RPC
#   TALLY_MIRROR or L1_TALLY_MIRROR_ADDRESS
#   L1_PUBLISHER_PRIVATE_KEY   (admin or setPublisher on the mirror)
#   ELECTION_ID
#   COUNTS                     e.g. 2,0   (or RESULT_HASH=0x…)
#
# Optional:
#   TOTAL_BALLOTS
#   L2_STATE_ROOT
#   SETTLEMENT or L1_SETTLEMENT_ADDRESS   (read RollupSettlement.stateRoot())
#   FORGE_ARGS                            extra args for `forge script`

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/smart-contracts"

MIRROR="${TALLY_MIRROR:-${L1_TALLY_MIRROR_ADDRESS:-}}"
KEY="${L1_PUBLISHER_PRIVATE_KEY:-${L1_PRIVATE_KEY:-}}"
RPC="${L1_RPC:-${L1_RPC_URL:-}}"

if [[ -z "${RPC}" || -z "${MIRROR}" || -z "${KEY}" ]]; then
  echo "L1 certification skipped (no-op): set L1_RPC, TALLY_MIRROR (or L1_TALLY_MIRROR_ADDRESS), and L1_PUBLISHER_PRIVATE_KEY to post the tally hash."
  echo "Tally remains on the Node / L2. See docs/OPERATOR.md."
  exit 0
fi

if [[ -z "${ELECTION_ID:-}" ]]; then
  echo "ELECTION_ID is required when L1 env is set." >&2
  exit 1
fi
if [[ -z "${COUNTS:-}" && -z "${RESULT_HASH:-}" ]]; then
  echo "COUNTS (csv) or RESULT_HASH is required when L1 env is set." >&2
  exit 1
fi

export TALLY_MIRROR="${MIRROR}"
export ELECTION_ID
export COUNTS="${COUNTS:-}"
export RESULT_HASH="${RESULT_HASH:-}"
export TOTAL_BALLOTS="${TOTAL_BALLOTS:-}"
export L2_STATE_ROOT="${L2_STATE_ROOT:-}"
export SETTLEMENT="${SETTLEMENT:-${L1_SETTLEMENT_ADDRESS:-}}"

exec forge script script/CertifyL1.s.sol \
  --rpc-url "${RPC}" \
  --private-key "${KEY}" \
  --broadcast \
  ${FORGE_ARGS:-}

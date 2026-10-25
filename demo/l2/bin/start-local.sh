#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial sequencer.
# Start ZK-Voting L2 sequencer + prover with plain Node. No Docker.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

mkdir -p "$DIR/data/blocks" "$DIR/data/proofs"

export DEV_MOCK_PROOF="${DEV_MOCK_PROOF:-true}"
export L2_RPC_HOST="${L2_RPC_HOST:-127.0.0.1}"
export L2_RPC_PORT="${L2_RPC_PORT:-8546}"

echo "NOT FOR PROFIT — ZK-Voting L2 (our sequencer, our prover). Not a commercial product."
echo "chainId=27427  rpc=http://${L2_RPC_HOST}:${L2_RPC_PORT}  DEV_MOCK_PROOF=${DEV_MOCK_PROOF}"

node "$DIR/sequencer/index.mjs" &
SEQ_PID=$!

cleanup() {
  trap - INT TERM EXIT
  kill "$SEQ_PID" "${PROVER_PID:-}" 2>/dev/null || true
  wait "$SEQ_PID" 2>/dev/null || true
  if [[ -n "${PROVER_PID:-}" ]]; then
    wait "$PROVER_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

ready=0
for _ in $(seq 1 80); do
  if node --input-type=module -e "
const port = process.env.L2_RPC_PORT || '8546';
const host = process.env.L2_RPC_HOST || '127.0.0.1';
const res = await fetch('http://' + host + ':' + port, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  signal: AbortSignal.timeout(500),
});
const json = await res.json();
if (json.result !== '0x6b23') process.exit(1);
" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done

if [[ "$ready" != "1" ]]; then
  echo "sequencer did not become ready on ${L2_RPC_HOST}:${L2_RPC_PORT}" >&2
  exit 1
fi

node "$DIR/prover/index.mjs" &
PROVER_PID=$!

echo "sequencer pid=${SEQ_PID}"
echo "prover pid=${PROVER_PID}"
echo "gasless for voters; settlement proofs are mock unless L1_RPC + SETTLEMENT_ADDRESS + PRIVATE_KEY are set."

wait -n
exit_code=$?
cleanup
exit "$exit_code"

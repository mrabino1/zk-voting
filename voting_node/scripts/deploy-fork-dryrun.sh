#!/usr/bin/env bash
# Mainnet-fork dry run of the L1 deploy through ZkVotingDeployer.
#
# Starts a throwaway anvil forked from MAINNET_FORK_RPC_URL (chain id 1),
# then runs `deploy.sh --target l1 --via-deployer --dry-run` against it.
# Nothing is broadcast: deploy.sh --dry-run only simulates, and the fork is
# local. Skips (exit 0) when MAINNET_FORK_RPC_URL is unset.
#
# Needs BATCH_VERIFIER (a contract that exists on mainnet), L2_FACTORY and,
# optionally, ADMIN / SEQUENCER / PROVER. The preflight refuses a mock, a
# missing verifier, and any contract above ZK_VOTING_CODE_SIZE_LIMIT
# (default 24576, EIP-170, the mainnet cap today).
#
#   --local-sim   no fork: anvil --chain-id 1 (mainnet rules, empty state).
#                 Deploys a stand-in BATCH_VERIFIER contract locally so the
#                 gates can be exercised without an RPC. Still nothing public.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_repo_env
need anvil "$FOUNDRY_HINT"
need cast "$FOUNDRY_HINT"

LOCAL_SIM=0
[[ "${1:-}" == "--local-sim" ]] && { LOCAL_SIM=1; shift; }
PORT="${FORK_ANVIL_PORT:-8646}"
RPC="http://127.0.0.1:${PORT}"

if [[ "$LOCAL_SIM" -eq 0 && -z "${MAINNET_FORK_RPC_URL:-}" ]]; then
  info "MAINNET_FORK_RPC_URL is not set; skipping the mainnet-fork dry run."
  exit 0
fi

ANVIL_ARGS=(--port "$PORT" --silent --chain-id 1)
if [[ "$LOCAL_SIM" -eq 0 ]]; then
  ANVIL_ARGS+=(--fork-url "$MAINNET_FORK_RPC_URL")
  info "forking mainnet from $(redact_url "$MAINNET_FORK_RPC_URL")"
fi
[[ -n "${ZK_VOTING_CODE_SIZE_LIMIT:-}" ]] && ANVIL_ARGS+=(--code-size-limit "$ZK_VOTING_CODE_SIZE_LIMIT")
anvil "${ANVIL_ARGS[@]}" &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
[[ "$(cast chain-id --rpc-url "$RPC")" == "1" ]] || die "fork did not report chain id 1"

SENDER="$(cast rpc --rpc-url "$RPC" eth_accounts | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
if [[ "$LOCAL_SIM" -eq 1 && -z "${BATCH_VERIFIER:-}" ]]; then
  # Any contract with code that does not report isMock(); a stand-in only.
  export BATCH_VERIFIER
  BATCH_VERIFIER="$(cd "$SC_DIR" && forge create src/hasher/KeccakHasher.sol:KeccakHasher --rpc-url "$RPC" \
    --unlocked --from "$SENDER" --broadcast --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])')"
  info "local sim: stand-in BATCH_VERIFIER $BATCH_VERIFIER (no real proof checking)"
fi
export L2_FACTORY="${L2_FACTORY:-0x00000000000000000000000000000000000000f1}"

args=(--target l1 --via-deployer --dry-run --rpc-url "$RPC" --sender "$SENDER" --record /dev/null)
[[ -n "${ZK_VOTING_CODE_SIZE_LIMIT:-}" ]] && args+=(--code-size-limit "$ZK_VOTING_CODE_SIZE_LIMIT")
"$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "${args[@]}" "$@"

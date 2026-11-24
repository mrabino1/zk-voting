#!/usr/bin/env bash
# Deploy ZkVotingRollup, the one L1 contract, with the Foundry scripts in smart-contracts/script.
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Targets:
#   local   DeployLocal.s.sol  rollup + MockBatchVerifier + a sample jurisdiction on Anvil (31337)
#   public  Deploy.s.sol       rollup + Groth16 batch verifier from a ceremony key (deploy ONCE)
#
# The forge script writes the deployment record (smart-contracts/deployments/local.json or
# deployments/<chainId>.json). This wrapper adds the one-time guard, the signer, the mainnet
# confirmation, and prints the lines to put in .env. Nothing is hardcoded.
#
# Docker Compose does the local deploy itself (the l1-deploy service); use --target local here
# for a host-side Anvil started with ./scripts/start-anvil.sh.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--target local|public] [options] [-- extra forge args]

  --target T          local (default) or public                 (DEPLOY_TARGET)
  --rpc-url URL       JSON-RPC to deploy to                     (DEPLOY_RPC_URL)
                        local default:  http://127.0.0.1:\${ANVIL_PORT:-8545}
                        public default: \$L1_RPC (or \$ETH_RPC_URL)
  --account NAME      forge keystore account (cast wallet import NAME ...)
                                                                (DEPLOYER_ACCOUNT)
  --sender ADDR       sender address for --account              (DEPLOYER_ADDRESS)
                      Raw key alternative: DEPLOYER_PRIVATE_KEY in env or .env.
                      On a local Anvil with no signer set, its first unlocked dev
                      account is used (no key is read or printed).
  --dry-run           simulate only; no broadcast
  --force             deploy even though ROLLUP_ADDRESS or a record with code exists
                      (sets FORCE_REDEPLOY=1; can split the chain of record)
  --yes               required to broadcast to Ethereum mainnet (chain id 1)
  --verify            after a broadcast, verify the contracts on Etherscan
                      (needs ETHERSCAN_API_KEY)                  (VERIFY=1)
  -h, --help          this help

local runs script/DeployLocal.s.sol; public runs script/Deploy.s.sol.
local reads OPERATOR, CLERK and JURISDICTION_ID (all optional; DeployLocal.s.sol).
public needs GOVERNOR (the governance address, ideally a multisig) and BATCH_VK (the
batch circuit's snarkjs verification_key.json from a completed ceremony). The batch
circuit is not built yet, so there is no BATCH_VK to deploy with today.
USAGE
}

load_repo_env
apply_l1_rpc_auth

TARGET="${DEPLOY_TARGET:-local}"
RPC_URL="${DEPLOY_RPC_URL:-}"
ACCOUNT="${DEPLOYER_ACCOUNT:-}"
SENDER="${DEPLOYER_ADDRESS:-}"
DRY_RUN=0
FORCE=0
YES=0
EXTRA=()
VERIFY="${VERIFY:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --rpc-url) RPC_URL="${2:?--rpc-url needs a value}"; shift 2 ;;
    --account) ACCOUNT="${2:?--account needs a value}"; shift 2 ;;
    --sender) SENDER="${2:?--sender needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes) YES=1; shift ;;
    --verify) VERIFY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

is_truthy "${FORCE_REDEPLOY:-}" && FORCE=1

case "$TARGET" in
  local) SCRIPT="DeployLocal.s.sol"; CONTRACT="DeployLocal" ;;
  public) SCRIPT="Deploy.s.sol"; CONTRACT="Deploy" ;;
  *) die "--target must be local or public (got '$TARGET')" ;;
esac

if [[ "$TARGET" == public ]]; then
  [[ -n "${GOVERNOR:-}" ]] || die "--target public needs GOVERNOR (the governance address)"
  [[ -n "${BATCH_VK:-}" && -f "${BATCH_VK:-}" ]] || die "--target public needs BATCH_VK, the batch circuit's verification_key.json (the circuit is not built yet)"
fi

need forge "$FOUNDRY_HINT"
need cast "$FOUNDRY_HINT"
[[ -f "$SC_DIR/script/$SCRIPT" ]] || die "missing $SC_DIR/script/$SCRIPT"

if [[ -z "$RPC_URL" ]]; then
  case "$TARGET" in
    local) RPC_URL="http://127.0.0.1:${ANVIL_PORT:-8545}" ;;
    public) RPC_URL="${L1_RPC:-${ETH_RPC_URL:-}}" ;;
  esac
fi
[[ -n "$RPC_URL" ]] || die "no RPC for --target $TARGET. Pass --rpc-url URL or set DEPLOY_RPC_URL or L1_RPC in the environment or .env."
SAFE_RPC="$(redact_url "$RPC_URL")"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)" ||
  die "no JSON-RPC answer from $SAFE_RPC. $([[ "$TARGET" == local ]] && echo 'Start one with ./scripts/start-anvil.sh')"
CLIENT="$(cast client --rpc-url "$RPC_URL" 2>/dev/null || true)"
IS_ANVIL=0
[[ "$CLIENT" == *anvil* || "$CLIENT" == *Anvil* ]] && IS_ANVIL=1

if [[ "$TARGET" == local && ( "$IS_ANVIL" -ne 1 || "$CHAIN_ID" != 31337 ) ]]; then
  die "--target local expects Anvil on chain 31337; $SAFE_RPC reports '$CLIENT' on chain $CHAIN_ID."
fi
if [[ "$CHAIN_ID" == "1" && "$DRY_RUN" -eq 0 && "$YES" -ne 1 ]]; then
  die "chain id 1 is Ethereum mainnet. Re-run with --dry-run first, then add --yes to broadcast."
fi

if [[ "$TARGET" == local ]]; then
  RECORD="$SC_DIR/deployments/local.json"
else
  RECORD="$SC_DIR/deployments/$CHAIN_ID.json"
fi

record_rollup() {
  [[ -f "$RECORD" ]] || return 0
  tr -d ' \n' <"$RECORD" | sed -n 's/.*"rollup":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p'
}

has_code() {
  [[ -n "$1" && "$(cast code "$1" --rpc-url "$RPC_URL" 2>/dev/null || echo 0x)" != "0x" ]]
}

# --- one-time deploy guard --------------------------------------------------
# The rollup is the chain of record for every jurisdiction: deploy it once.
existing="$(record_rollup)"
if [[ "$FORCE" -ne 1 ]]; then
  if [[ "$TARGET" == public && -n "${ROLLUP_ADDRESS:-}" ]]; then
    die "refusing to deploy: ROLLUP_ADDRESS is already set ($ROLLUP_ADDRESS). The rollup deploys once. Pass --force only if you mean to replace the chain of record."
  fi
  if has_code "$existing"; then
    die "refusing to deploy: $RECORD records ZkVotingRollup at $existing, which has code on chain $CHAIN_ID. Pass --force only if you mean to replace it."
  fi
  [[ -n "$existing" ]] && info "note: $RECORD is from an earlier chain (no code at $existing); it will be replaced"
else
  warn "--force: deploying a second rollup on chain $CHAIN_ID. Do not do this during a live election."
fi

if is_truthy "$VERIFY" && [[ "$DRY_RUN" -eq 0 && -z "${ETHERSCAN_API_KEY:-}" ]]; then
  die "--verify needs ETHERSCAN_API_KEY in the environment or .env"
fi

# --- signer -----------------------------------------------------------------
SIGNER_ARGS=()
SIGNER_DESC=""
FORGE_ENV=()
if [[ -n "$ACCOUNT" ]]; then
  SIGNER_ARGS=(--account "$ACCOUNT")
  [[ -n "$SENDER" ]] && SIGNER_ARGS+=(--sender "$SENDER")
  SIGNER_DESC="keystore account '$ACCOUNT'"
elif [[ -n "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  SIGNER_ARGS=(--private-key "$DEPLOYER_PRIVATE_KEY")
  SENDER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null)" ||
    die "DEPLOYER_PRIVATE_KEY is not a valid private key"
  SIGNER_DESC="DEPLOYER_PRIVATE_KEY ($SENDER)"
  # DeployLocal signs with PRIVATE_KEY; hand it the same key.
  [[ "$TARGET" == local ]] && FORGE_ENV+=(PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY")
elif [[ "$IS_ANVIL" -eq 1 ]]; then
  if [[ -z "$SENDER" ]]; then
    SENDER="$(rpc_call "$RPC_URL" eth_accounts | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0] if a else "")' 2>/dev/null || true)"
  fi
  [[ -n "$SENDER" ]] || die "the Anvil node has no unlocked accounts; set DEPLOYER_PRIVATE_KEY or --account"
  SIGNER_ARGS=(--unlocked --sender "$SENDER")
  SIGNER_DESC="Anvil unlocked dev account $SENDER"
else
  die "no signer. Set DEPLOYER_PRIVATE_KEY (env or .env), or pass --account NAME for a forge keystore (cast wallet import NAME --interactive)."
fi

info "zk-voting deploy"
info "  target:  $TARGET ($SCRIPT)"
info "  rpc:     $SAFE_RPC (chain $CHAIN_ID${CLIENT:+, $CLIENT})"
info "  signer:  $SIGNER_DESC"
info "  mode:    $([[ "$DRY_RUN" -eq 1 ]] && echo 'dry run (simulation, no broadcast)' || echo broadcast)"
info "  record:  $([[ "$DRY_RUN" -eq 1 ]] && echo 'none (dry run)' || echo "$RECORD")"
info ""

BROADCAST_ARGS=()
[[ "$DRY_RUN" -eq 0 ]] && BROADCAST_ARGS=(--broadcast --slow)

set +e
(
  cd "$SC_DIR"
  env "${FORGE_ENV[@]}" forge script "script/$SCRIPT:$CONTRACT" \
    --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}" "${BROADCAST_ARGS[@]}" -vv "${EXTRA[@]}"
) 2>&1 | sed -E 's/(--private-key[= ])[^ ]+/\1***/g'
status=${PIPESTATUS[0]}
set -e
[[ "$status" -eq 0 ]] || die "forge script failed (exit $status)."
[[ "$DRY_RUN" -eq 1 ]] && { info "dry run finished; nothing was broadcast or recorded."; exit 0; }

rollup="$(record_rollup)"
has_code "$rollup" || die "forge finished but $RECORD has no rollup address with code"

info ""
info "ZkVotingRollup: $rollup (record $RECORD)"
info "Set these in .env (or your secret store) for the node and the l2 operator:"
printf 'L1_CHAIN_ID=%s\nROLLUP_ADDRESS=%s\n' "$CHAIN_ID" "$rollup"
if [[ "$TARGET" == public ]]; then
  info "Then, as GOVERNOR: setOperator(<l2 operator>, true), createJurisdiction(<id>, <admin>, <name>);"
  info "as the jurisdiction admin: setClerk(<id>, <node account>, true). Set ROLLUP_JURISDICTION_ID."
fi

# --- Etherscan verification -------------------------------------------------
if is_truthy "$VERIFY"; then
  BROADCAST_FILE="$SC_DIR/broadcast/$SCRIPT/$CHAIN_ID/run-latest.json"
  info ""
  info "verifying on Etherscan (chain $CHAIN_ID)"
  python3 "$(dirname "${BASH_SOURCE[0]}")/lib/verify_targets.py" "$BROADCAST_FILE" "$SC_DIR/out" |
    while IFS='|' read -r addr name args; do
      info "  $name at $addr"
      (cd "$SC_DIR" && forge verify-contract "$addr" "$name" --chain "$CHAIN_ID" \
        --constructor-args "$args" --watch) ||
        warn "verification failed for $name at $addr (retry later with forge verify-contract)"
    done
fi

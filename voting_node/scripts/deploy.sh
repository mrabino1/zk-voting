#!/usr/bin/env bash
# Deploy the zk-voting contracts with the Foundry scripts in smart-contracts/script.
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Targets:
#   local  DeployLocal.s.sol  full stack + sample election on a local Anvil
#   l2     DeployL2.s.sol     election stack, EntryPoint, passkey factory, paymaster
#   l1     DeployL1.s.sol     RollupSettlement, L1TallyMirror, mailbox (deploy ONCE)
#
# Nothing is hardcoded: the RPC, chain, and signer come from flags or env.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

# The one-time pins the app reads. Same list as DeployGuard.sol / tools/deploy/l1Guard.mjs.
PINNED_KEYS=(SETTLEMENT_ADDRESS VERIFIER_ADDRESS L1_TALLY_MIRROR_ADDRESS L1_SETTLEMENT_ADDRESS
  ELECTION_FACTORY_ADDRESS BALLOT_INBOX_ADDRESS)

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--target local|l2|l1] [options] [-- extra forge args]

  --target T          local (default), l2, or l1             (DEPLOY_TARGET)
  --rpc-url URL       JSON-RPC to deploy to                  (DEPLOY_RPC_URL)
                        local default: http://127.0.0.1:\${ANVIL_PORT:-8545}
                        l1 default:    \$L1_RPC (or \$ETH_RPC_URL)
                        l2:            required
  --account NAME      forge keystore account (cast wallet import NAME ...)
                                                             (DEPLOYER_ACCOUNT)
  --sender ADDR       sender address for --account / unlocked (DEPLOYER_ADDRESS)
                      Raw key alternative: DEPLOYER_PRIVATE_KEY in env or .env.
                      On a local Anvil with no signer set, the node's first
                      unlocked dev account is used (no key is read or printed).
  --record FILE       deployment record                      (DEPLOYMENTS_FILE)
                        default: deployments/<chainId>.json
  --dry-run           simulate only; no broadcast, no record
  --force             redeploy even though addresses or a record exist
                      (sets FORCE_REDEPLOY=1; can split the chain of record)
  --yes               required to broadcast to Ethereum mainnet (chain id 1)
  --via-deployer      deploy through ZkVotingDeployer (CREATE2, staged, admin
                      handoff; script/DeployViaDeployer.s.sol) (DEPLOY_VIA_DEPLOYER)
  --verify            after a broadcast, verify every contract on Etherscan
                      (needs ETHERSCAN_API_KEY)               (VERIFY=1)
  --code-size-limit N runtime code cap of the target chain    (ZK_VOTING_CODE_SIZE_LIMIT)
                      default 24576 (EIP-170). --via-deployer refuses to
                      simulate a contract above it.
  -h, --help          this help

l1 also needs L2_FACTORY (or ELECTION_FACTORY_ADDRESS from the l2 run) and
BATCH_VERIFIER, exactly as DeployL1.s.sol documents.

--via-deployer reads ADMIN (final admin of every module; default: the
signer). When ADMIN is not the signer, the admin-only follow-up calls are
printed as ADMIN_TODO lines and saved in the record under adminTodo.
USAGE
}

load_repo_env

TARGET="${DEPLOY_TARGET:-local}"
RPC_URL="${DEPLOY_RPC_URL:-}"
ACCOUNT="${DEPLOYER_ACCOUNT:-}"
SENDER="${DEPLOYER_ADDRESS:-}"
RECORD="${DEPLOYMENTS_FILE:-}"
DRY_RUN=0
FORCE=0
YES=0
EXTRA=()
VIA_DEPLOYER="${DEPLOY_VIA_DEPLOYER:-0}"
VERIFY="${VERIFY:-0}"
CODE_SIZE_LIMIT="${ZK_VOTING_CODE_SIZE_LIMIT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --rpc-url) RPC_URL="${2:?--rpc-url needs a value}"; shift 2 ;;
    --account) ACCOUNT="${2:?--account needs a value}"; shift 2 ;;
    --sender) SENDER="${2:?--sender needs a value}"; shift 2 ;;
    --record) RECORD="${2:?--record needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes) YES=1; shift ;;
    --via-deployer) VIA_DEPLOYER=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --code-size-limit) CODE_SIZE_LIMIT="${2:?--code-size-limit needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

is_truthy "${FORCE_REDEPLOY:-}" && FORCE=1

case "$TARGET" in
  local) SCRIPT="DeployLocal.s.sol"; CONTRACT="DeployLocal" ;;
  l2) SCRIPT="DeployL2.s.sol"; CONTRACT="DeployL2" ;;
  l1) SCRIPT="DeployL1.s.sol"; CONTRACT="DeployL1" ;;
  *) die "--target must be local, l2, or l1 (got '$TARGET')" ;;
esac
if is_truthy "$VIA_DEPLOYER"; then
  VIA_DEPLOYER=1
  SCRIPT="DeployViaDeployer.s.sol"; CONTRACT="DeployViaDeployer"
else
  VIA_DEPLOYER=0
fi
if [[ -n "$CODE_SIZE_LIMIT" && ! "$CODE_SIZE_LIMIT" =~ ^[0-9]+$ ]]; then
  die "--code-size-limit must be a number of bytes (got '$CODE_SIZE_LIMIT')"
fi

need forge "$FOUNDRY_HINT"
need cast "$FOUNDRY_HINT"
need python3 "It writes the deployment record."
[[ -f "$SC_DIR/script/$SCRIPT" ]] || die "missing $SC_DIR/script/$SCRIPT"

if [[ -z "$RPC_URL" ]]; then
  case "$TARGET" in
    local) RPC_URL="http://127.0.0.1:${ANVIL_PORT:-8545}" ;;
    l1) RPC_URL="${L1_RPC:-${ETH_RPC_URL:-}}" ;;
  esac
fi
[[ -n "$RPC_URL" ]] || die "no RPC for --target $TARGET. Pass --rpc-url URL or set DEPLOY_RPC_URL$([[ "$TARGET" == l1 ]] && echo ' or L1_RPC') in the environment or .env."
SAFE_RPC="$(redact_url "$RPC_URL")"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>/dev/null)" ||
  die "no JSON-RPC answer from $SAFE_RPC. $([[ "$TARGET" == local ]] && echo 'Start one with ./scripts/start-anvil.sh')"
CLIENT="$(cast client --rpc-url "$RPC_URL" 2>/dev/null || true)"
IS_ANVIL=0
[[ "$CLIENT" == *anvil* || "$CLIENT" == *Anvil* ]] && IS_ANVIL=1

if [[ "$TARGET" == local && "$IS_ANVIL" -ne 1 ]]; then
  die "--target local expects an Anvil node; $SAFE_RPC reports '$CLIENT' (chain $CHAIN_ID). Use --target l2 or l1 for a real network."
fi
if [[ "$CHAIN_ID" == "1" && "$DRY_RUN" -eq 0 && "$YES" -ne 1 ]]; then
  die "chain id 1 is Ethereum mainnet. Re-run with --dry-run first, then add --yes to broadcast."
fi

RECORD="${RECORD:-$REPO_ROOT/deployments/$CHAIN_ID.json}"

record_deployed() {
  [[ -f "$RECORD" ]] || return 1
  python3 - "$RECORD" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
addrs = r.get("addresses") or {}
sys.exit(0 if r.get("deployed") is True and any(str(v).strip() for v in addrs.values()) else 1)
PY
}

record_factory() {
  python3 - "$RECORD" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print((r.get("addresses") or {}).get("ELECTION_FACTORY_ADDRESS", ""))
PY
}

# --- one-time deploy guard --------------------------------------------------
FORGE_ENV=(-u DEPLOYMENTS_FILE)
if [[ "$TARGET" == local ]]; then
  # A local Anvil is disposable. Pins in .env (for a real network) must not
  # block it, so they are hidden from this forge run only.
  for k in "${PINNED_KEYS[@]}"; do
    if [[ -n "${!k:-}" ]]; then
      info "note: ignoring $k from the environment for this local deploy"
    fi
    FORGE_ENV+=(-u "$k")
  done
  if record_deployed && [[ "$FORCE" -ne 1 ]]; then
    fac="$(record_factory)"
    if [[ -n "$fac" && "$(cast code "$fac" --rpc-url "$RPC_URL" 2>/dev/null || echo 0x)" != "0x" ]]; then
      die "$RECORD records a live deploy on this Anvil (factory $fac has code). Use --force to deploy a second stack."
    fi
    info "note: $RECORD is from an earlier Anvil session (no code at its factory); it will be replaced"
  fi
else
  if [[ "$FORCE" -ne 1 ]]; then
    set_keys=()
    for k in "${PINNED_KEYS[@]}"; do
      [[ -n "${!k:-}" ]] && set_keys+=("$k")
    done
    if [[ ${#set_keys[@]} -gt 0 ]]; then
      die "refusing $TARGET deploy: already set: ${set_keys[*]}. Contracts on the chain of record deploy once. Unset them, or pass --force only if you mean to replace the chain of record."
    fi
    if record_deployed; then
      die "refusing $TARGET deploy: $RECORD already records a deploy on chain $CHAIN_ID. Pass --force only if you mean to replace the chain of record."
    fi
  else
    warn "--force: redeploying on chain $CHAIN_ID. Do not do this during a live election."
  fi
fi
if [[ "$FORCE" -eq 1 ]]; then
  FORGE_ENV+=(FORCE_REDEPLOY=1)
fi

if [[ "$VIA_DEPLOYER" -eq 1 ]]; then
  FORGE_ENV+=(ZK_VOTING_DEPLOY_TARGET="$TARGET")
  [[ "$DRY_RUN" -eq 1 ]] && FORGE_ENV+=(ZK_VOTING_DRY_RUN=1)
  [[ "$CHAIN_ID" == "1" && "$YES" -eq 1 ]] && FORGE_ENV+=(ZK_VOTING_MAINNET_CONFIRMED=1)
  [[ -n "$CODE_SIZE_LIMIT" ]] && FORGE_ENV+=(ZK_VOTING_CODE_SIZE_LIMIT="$CODE_SIZE_LIMIT")
fi
if is_truthy "$VERIFY" && [[ "$DRY_RUN" -eq 0 && -z "${ETHERSCAN_API_KEY:-}" ]]; then
  die "--verify needs ETHERSCAN_API_KEY in the environment or .env"
fi

# --- dev / proving flags ----------------------------------------------------
# Set these as ZK_VOTING_* (env or .env). The forge scripts read ZK_VOTING_*
# directly; each one that is set is passed through to this forge run.
for flag in ALLOW_MOCK_VERIFIER USE_MOCK_VERIFIER PROVING_PATH HASH_SCHEME \
  VOTE_VERIFIER TALLY_VERIFIER SETTLEMENT_MOCK_MODE; do
  zk="ZK_VOTING_$flag"
  if [[ -n "${!zk:-}" ]]; then
    FORGE_ENV+=("$zk=${!zk}")
  fi
done

# --- signer -----------------------------------------------------------------
SIGNER_ARGS=()
SIGNER_DESC=""
if [[ -n "$ACCOUNT" ]]; then
  SIGNER_ARGS=(--account "$ACCOUNT")
  [[ -n "$SENDER" ]] && SIGNER_ARGS+=(--sender "$SENDER")
  SIGNER_DESC="keystore account '$ACCOUNT'"
elif [[ -n "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  SIGNER_ARGS=(--private-key "$DEPLOYER_PRIVATE_KEY")
  SENDER="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null)" ||
    die "DEPLOYER_PRIVATE_KEY is not a valid private key"
  SIGNER_DESC="DEPLOYER_PRIVATE_KEY ($SENDER)"
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
[[ "$DRY_RUN" -eq 0 ]] && BROADCAST_ARGS=(--broadcast)

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/zk-voting-deploy.XXXXXX")"
trap 'rm -f "$LOG_FILE"' EXIT

set +e
(
  cd "$SC_DIR"
  env "${FORGE_ENV[@]}" forge script "script/$SCRIPT:$CONTRACT" \
    --rpc-url "$RPC_URL" "${SIGNER_ARGS[@]}" "${BROADCAST_ARGS[@]}" -vv "${EXTRA[@]}"
) 2>&1 | tee "$LOG_FILE" | sed -E 's/(--private-key[= ])[^ ]+/\1***/g'
status=${PIPESTATUS[0]}
set -e
[[ "$status" -eq 0 ]] || die "forge script failed (exit $status). Nothing was recorded."

BROADCAST_FILE="$SC_DIR/broadcast/$SCRIPT/$CHAIN_ID/run-latest.json"
[[ "$DRY_RUN" -eq 1 ]] && BROADCAST_FILE="$SC_DIR/broadcast/$SCRIPT/$CHAIN_ID/dry-run/run-latest.json"

python3 - "$LOG_FILE" "$RECORD" "$BROADCAST_FILE" "$TARGET" "$CHAIN_ID" "$SCRIPT" "$SENDER" "$DRY_RUN" <<'PY'
import datetime, json, os, re, sys

log_file, record, bfile, target, chain_id, script, sender, dry = sys.argv[1:9]
dry = dry == "1"

# DeployLocal / DeployL1 / DeployL2 log NAME=value lines under "== Logs ==".
values = {}
admin_todo = []
for line in open(log_file, encoding="utf-8", errors="replace"):
    t = re.match(r"^\s+ADMIN_TODO (\S+) to=(0x[0-9a-fA-F]{40}) data=(0x[0-9a-fA-F]*)\s*$", line)
    if t:
        admin_todo.append({"call": t.group(1), "to": t.group(2), "data": t.group(3)})
        continue
    m = re.match(r"^\s+([A-Z][A-Z0-9_]*)=(\S+)\s*$", line)
    if m:
        values[m.group(1)] = m.group(2)

# Script log name -> the env var the app reads.
ENV_NAME = {
    "FACTORY": "ELECTION_FACTORY_ADDRESS",
    "INBOX": "BALLOT_INBOX_ADDRESS",
    "VERIFIER": "VERIFIER_ADDRESS",
    "SETTLEMENT": "SETTLEMENT_ADDRESS",
    "TALLY_MIRROR": "L1_TALLY_MIRROR_ADDRESS",
    "L2_FACTORY": "L2_FACTORY",
    "BATCH_VERIFIER": "BATCH_VERIFIER",
}
addr_re = re.compile(r"^0x[0-9a-fA-F]{40}$")
zero = "0x" + "0" * 40
addresses, other = {}, {}
for k, v in values.items():
    if addr_re.match(v):
        if v.lower() == zero:
            continue
        addresses[ENV_NAME.get(k, k + "_ADDRESS")] = v
    else:
        other[k] = v
if "SETTLEMENT_ADDRESS" in addresses:
    addresses["L1_SETTLEMENT_ADDRESS"] = addresses["SETTLEMENT_ADDRESS"]

txs, total = [], 0
if os.path.isfile(bfile):
    b = json.load(open(bfile))
    receipts = b.get("receipts") or []
    for i, tx in enumerate(b.get("transactions") or []):
        gas = None
        if i < len(receipts) and receipts[i].get("gasUsed"):
            gas = int(receipts[i]["gasUsed"], 16)
        elif (tx.get("transaction") or {}).get("gas"):
            gas = int(tx["transaction"]["gas"], 16)  # dry run: estimate
        txs.append({
            "type": tx.get("transactionType"),
            "contract": tx.get("contractName"),
            "function": tx.get("function"),
            "address": tx.get("contractAddress"),
            "gasUsed": gas,
        })
        total += gas or 0

if not addresses:
    print("error: forge succeeded but printed no NAME=0x... addresses", file=sys.stderr)
    sys.exit(1)

print()
print("Deployed addresses" + (" (simulated; nothing was broadcast)" if dry else ""))
for k in sorted(addresses):
    print(f"  {k:<34} {addresses[k]}")
for k in sorted(other):
    print(f"  {k:<34} {other[k]}")
if txs:
    kind = "estimated" if dry else "used"
    print(f"\nGas {kind}: {total:,} over {len(txs)} transactions")

if not dry:
    rec = {
        "deployed": True,
        "chainId": int(chain_id),
        "target": target,
        "script": script,
        "deployer": sender or None,
        "deployedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "note": "Written by scripts/deploy.sh. Do not commit. App containers read these from the environment.",
        "addresses": addresses,
        "values": other,
        "gas": {"total": total, "transactions": txs},
    }
    if admin_todo:
        rec["adminTodo"] = admin_todo
    os.makedirs(os.path.dirname(os.path.abspath(record)), exist_ok=True)
    with open(record, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2)
        fh.write("\n")
    print(f"\nRecord written: {record}")

print("\nSet these in .env (or your secret store) for the app and the next deploy step:")
keys = ["ELECTION_FACTORY_ADDRESS", "BALLOT_INBOX_ADDRESS", "VERIFIER_ADDRESS",
        "SETTLEMENT_ADDRESS", "L1_SETTLEMENT_ADDRESS", "L1_TALLY_MIRROR_ADDRESS"]
for k in keys:
    if k in addresses:
        print(f"{k}={addresses[k]}")
if admin_todo:
    print("\nThe final admin must send these calls (multisig or the admin key):")
    for t in admin_todo:
        print(f"  {t['call']}: to={t['to']} data={t['data']}")
if target == "l2" and "ELECTION_FACTORY_ADDRESS" in addresses:
    print(f"# for --target l1:\nL2_FACTORY={addresses['ELECTION_FACTORY_ADDRESS']}")
PY

# --- Etherscan verification -------------------------------------------------
if is_truthy "$VERIFY" && [[ "$DRY_RUN" -eq 0 ]]; then
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

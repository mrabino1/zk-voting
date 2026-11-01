#!/usr/bin/env bash
# Local-only end-to-end check of ZkVotingDeployer on a throwaway anvil.
# Starts anvil, deploys the full local stack through the deployer, then checks
# predicted addresses, wiring and that no residual privilege remains with the
# deployer contract. Never touches a public network.
#
# anvil runs with --code-size-limit 65536 to emulate the EIP-7954 runtime cap:
# RollupSettlement and BallotInbox exceed EIP-170 (24576). See docs/L2_VPS_SETUP.md.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

PORT="${E2E_ANVIL_PORT:-8645}"
RPC="http://127.0.0.1:${PORT}"
# Anvil public dev key #0 — well-known, local chain 31337 only.
ANVIL_PUBLIC_DEV_KEY_LOCAL_ONLY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

anvil --port "$PORT" ${E2E_ANVIL_ARGS---code-size-limit 65536} --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "not anvil" >&2; exit 1; }

OUT=$(mktemp)
ZK_VOTING_CODE_SIZE_LIMIT=65536 ZK_VOTING_DEPLOY_TARGET=local \
  forge script script/DeployViaDeployer.s.sol:DeployViaDeployer --via-ir \
  --rpc-url "$RPC" --private-key "$ANVIL_PUBLIC_DEV_KEY_LOCAL_ONLY" --broadcast >"$OUT" 2>&1 \
  || { tail -40 "$OUT"; exit 1; }

get() { sed -nE "s/^ +$1=(0x[0-9a-fA-F]{40})$/\1/p" "$OUT" | tail -1; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }
lc() { tr 'A-F' 'a-f' <<<"$1"; }

D=$(get ZK_VOTING_DEPLOYER); ADMIN=$(get ADMIN); F=$(get FACTORY)
# every preview line must match the deployed address
while read -r _ _ name addr; do
  key=""
  case "$name" in
    ElectionFactory) key=FACTORY;; JurisdictionRegistry) key=JURISDICTION_REGISTRY;;
    VoterRegistry) key=VOTER_REGISTRY;; DisqualificationRegistry) key=DISQUALIFICATION_REGISTRY;;
    BallotInbox) key=INBOX;; Tally) key=TALLY;; ZkVotingEntryPoint) key=ENTRY_POINT;;
    PasskeyAccountFactory) key=ACCOUNT_FACTORY;; ZkVotingPaymaster) key=PAYMASTER;;
    RollupSettlement) key=SETTLEMENT;; ZkVotingMailbox) key=MAILBOX;; L1TallyMirror) key=TALLY_MIRROR;;
    Hasher) key=HASHER;;
  esac
  [ -n "$key" ] && check "predict $name" "$(lc "$addr")" "$(lc "$(get $key)")"
done < <(grep -E "^ +preview (stage[0-9]|l1) " "$OUT")
check "predict DEPLOYER" "$(lc "$(sed -nE 's/^ +preview DEPLOYER (0x[0-9a-fA-F]+)$/\1/p' "$OUT")")" "$(lc "$D")"

c() { cast call --rpc-url "$RPC" "$@"; }
b() { c "$@" | tr -d '\n'; }
addr() { cast parse-bytes32-address "$(c "$@")" 2>/dev/null || c "$@"; }
check "deployer sealed" "$(b "$D" 'sealed_()(bool)')" true
check "factory admin" "$(lc "$(b "$F" 'admin()(address)')")" "$(lc "$ADMIN")"
check "factory pendingAdmin cleared" "$(b "$F" 'pendingAdmin()(address)')" 0x0000000000000000000000000000000000000000

for role in PLATFORM_SUPER_ADMIN_ROLE PLATFORM_ADMIN_ROLE ADMIN_ROLE; do
  r=$(cast keccak "$role")
  check "deployer lacks $role" "$(b "$F" 'roles(bytes32,address)(bool)' "$r" "$D")" false
  check "admin has $role" "$(b "$F" 'roles(bytes32,address)(bool)' "$r" "$ADMIN")" true
done

check "factory.tally" "$(lc "$(b "$F" 'tallyVerifier()(address)')")" "$(lc "$(get TALLY)")"
check "factory.inbox" "$(lc "$(b "$F" 'ballotInbox()(address)')")" "$(lc "$(get INBOX)")"
for k in JURISDICTION_REGISTRY PAYMASTER SETTLEMENT MAILBOX TALLY_MIRROR; do
  check "$k admin" "$(lc "$(b "$(get $k)" 'admin()(address)')")" "$(lc "$ADMIN")"
done
check "mirror.related" "$(lc "$(b "$(get TALLY_MIRROR)" 'related()(address)')")" "$(lc "$(get MAILBOX)")"
check "mirror.l2Factory" "$(lc "$(b "$(get TALLY_MIRROR)" 'l2Factory()(address)')")" "$(lc "$F")"
check "tally verifier set" "$(lc "$(b "$(get TALLY)" 'tallyProofVerifier()(address)')")" "$(lc "$(get VERIFIER)")"
# A sealed deployer refuses everything, even from the launcher.
if cast send --rpc-url "$RPC" --private-key "$ANVIL_PUBLIC_DEV_KEY_LOCAL_ONLY" "$D" 'seal()' >/dev/null 2>&1; then
  echo "FAIL sealed deployer accepted seal()"; fail=1; else echo "ok   sealed deployer reverts"; fi

echo "gas per transaction:"
paste <(jq -r '.transactions[] | (.function // ("create " + (.contractName // "?")))' broadcast/DeployViaDeployer.s.sol/31337/run-latest.json) \
      <(jq -r '.receipts[] | .gasUsed' broadcast/DeployViaDeployer.s.sol/31337/run-latest.json | xargs -n1 printf '%d\n') | sed 's/^/  /'
rm -f "$OUT"
[ "$fail" = 0 ] && echo "deployer e2e: PASS" || { echo "deployer e2e: FAIL"; exit 1; }

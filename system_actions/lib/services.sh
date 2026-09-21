# NOT FOR PROFIT — civic public good, not a commercial product.
# Local JSON store + Node/L2/chain connectivity (this repo has no Postgres).

http_ok() {
  local url="$1"
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

rpc_ok() {
  local url="$1"
  [[ -z "$url" ]] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 5 -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$url" >/dev/null 2>&1
}

cmd_data_status() {
  source_project_env
  echo
  printf '%s%s%s\n' "$BLD" "JSON data store (not Postgres / not Drizzle)" "$RST"
  echo "  this repo has no db:push / db:migrate — clerks write $STORE_FILE"
  echo "  path      $STORE_FILE"
  if [[ ! -f "$STORE_FILE" ]]; then
    warn "  missing — Node will create it on first boot"
    echo
    return 0
  fi
  local size mtime
  size="$(wc -c < "$STORE_FILE" | tr -d ' ')"
  mtime="$(date -r "$STORE_FILE" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo unknown)"
  echo "  size      ${size} bytes"
  echo "  mtime     $mtime"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$STORE_FILE" <<'PY'
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception as e:
    print("  parse     failed:", e)
    raise SystemExit(0)
meta = d.get("meta") or {}
print("  version   ", meta.get("version", "?"))
print("  nodeId    ", meta.get("nodeId", "?"))
for key in (
    "users",
    "jurisdictions",
    "elections",
    "registrations",
    "disqualifications",
    "votes",
    "envelopes",
    "receipts",
):
    val = d.get(key)
    n = len(val) if isinstance(val, list) else 0
    print(f"  {key:<16}{n}")
PY
  else
    warn "  python3 not installed — skipping collection counts"
  fi
  echo
}

cmd_connectivity() {
  source_project_env
  echo
  printf '%s%s%s\n' "$BLD" "Connectivity (from this machine)" "$RST"
  echo

  local node_url l2_url chain_rpc l1_rpc
  node_url="${ZK_VOTING_HEALTH_URL:-$HEALTH_URL}"
  l2_url="${ZK_VOTING_L2_HEALTH_URL:-$L2_HEALTH_URL}"
  chain_rpc="${CHAIN_RPC:-}"
  l1_rpc="${L1_RPC:-}"

  if http_ok "$node_url"; then
    ok "  Node        reachable — $node_url"
  else
    warn "  Node        not reachable — $node_url"
  fi

  if http_ok "$l2_url"; then
    ok "  L2 health   reachable — $l2_url"
  else
    warn "  L2 health   not reachable — $l2_url"
  fi

  if [[ -z "$chain_rpc" ]]; then
    echo "  CHAIN_RPC   (unset — JSON-only demo)"
  elif rpc_ok "$chain_rpc" || http_ok "$chain_rpc"; then
    ok "  CHAIN_RPC   reachable — $chain_rpc"
  else
    warn "  CHAIN_RPC   not reachable — $chain_rpc"
  fi

  if [[ -z "$l1_rpc" ]]; then
    echo "  L1_RPC      (unset — tally-hash certification skipped)"
  elif rpc_ok "$l1_rpc" || http_ok "$l1_rpc"; then
    ok "  L1_RPC      reachable — $l1_rpc"
  else
    warn "  L1_RPC      not reachable — $l1_rpc"
  fi

  echo
  echo "  Pin factory / inbox / verifier in .env; this repo does not run Drizzle."
  echo "  CLI: ./system_actions.sh 6   or   ./system_actions.sh connectivity"
  echo
}

cmd_list_users() {
  source_project_env
  echo
  info "Local Node users (handle + role only — no emails, no credentials)"
  echo "  store  $STORE_FILE"
  echo
  if [[ ! -f "$STORE_FILE" ]]; then
    warn "no republic.json yet — start the Node once, or use launch (option 1)"
    echo
    return 0
  fi
  local filter="${1:-}"
  if [[ -z "$filter" && -t 0 ]]; then
    printf "  Optional filter (substring on handle/role, Enter for all): "
    read -r filter
    filter=$(echo "$filter" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  fi
  FILTER="$filter" python3 - "$STORE_FILE" <<'PY'
import json, os, sys
path = sys.argv[1]
filt = (os.environ.get("FILTER") or "").strip().lower()
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception as e:
    print("  failed to parse store:", e)
    raise SystemExit(1)
users = data.get("users") or []
shown = 0
print(f"  {'handle':<24} role")
print("  " + "-" * 48)
for user in users:
    handle = str(user.get("handle") or "")
    role = str(user.get("role") or "")
    hay = f"{handle} {role}".lower()
    if filt and filt not in hay:
        continue
    print(f"  {handle:<24} {role}")
    shown += 1
print()
print(f"  {shown} of {len(users)} users")
PY
  echo
}

cmd_dev_flags() {
  source_project_env
  echo
  printf '%s%s%s\n' "$BLD" "Dev-only flags (must stay off on master / production)" "$RST"
  echo "  NODE_ENV                ${NODE_ENV:-}"
  echo "  ALLOW_DEV_LOGIN         ${ALLOW_DEV_LOGIN:-}"
  echo "  ALLOW_SMART_CARD_MOCK   ${ALLOW_SMART_CARD_MOCK:-}"
  echo "  ALLOW_CIVIC_ID_MOCK     ${ALLOW_CIVIC_ID_MOCK:-}"
  echo "  REQUIRE_EMAIL_MFA       ${REQUIRE_EMAIL_MFA:-}"
  echo
  echo "  DealPunchList sandbox_participant does not exist here."
  echo "  Dev login is POST /api/auth/dev-login when ALLOW_DEV_LOGIN=1"
  echo "  (ignored when NODE_ENV=production). Local users: ./system_actions.sh 7"
  echo
}

# Honest aliases for DealPunchList option names that do not apply.
push_schema() {
  warn "no Drizzle / Postgres in zk-voting — JSON store only"
  cmd_data_status
}

db_access_report() {
  cmd_connectivity
}

add_sandbox_participant() {
  if [[ "${1:-}" == "remove" || "${1:-}" == "prod" || "${1:-}" == "production" || "${1:-}" == "test" ]]; then
    warn "sandbox_participant add/remove is a DealPunchList Postgres flag; zk-voting has no such table"
    shift
  fi
  warn "listing local Node users (handle + role) instead"
  cmd_list_users "${1:-}"
}

list_sandbox_participants() {
  warn "no sandbox_participant flag — listing local Node users instead"
  cmd_list_users "${1:-}"
}

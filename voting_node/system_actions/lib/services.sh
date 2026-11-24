# NOT FOR PROFIT — civic public good, not a commercial product.
# Local JSON store + Node/L2/chain connectivity (this repo has no Postgres).

http_ok() {
  local url="$1"
  local token="${2:-}"
  command -v curl >/dev/null 2>&1 || return 1
  if [[ -n "$token" ]]; then
    curl -fsS --max-time 5 -H "Authorization: Bearer ${token}" "$url" >/dev/null 2>&1
  else
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1
  fi
}

rpc_ok() {
  local url="$1"
  local token="${2:-}"
  [[ -z "$url" ]] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  local -a hdr=(-H 'content-type: application/json')
  if [[ -n "$token" ]]; then
    hdr+=(-H "Authorization: Bearer ${token}")
  fi
  curl -fsS --max-time 5 "${hdr[@]}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$url" >/dev/null 2>&1
}

# Scheme and host only: provider RPC URLs often carry an API key in the path.
redact_rpc() {
  printf '%s' "$1" | sed -E 's#^([a-z]+://[^/]+).*#\1#'
}

cmd_data_status() {
  source_project_env
  echo
  printf '%s%s%s\n' "$BLD" "JSON data store (no SQL database)" "$RST"
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

  local node_url l2_url l1_rpc l1_auth
  node_url="${ZK_VOTING_HEALTH_URL:-$HEALTH_URL}"
  l2_url="${ZK_VOTING_L2_HEALTH_URL:-$L2_HEALTH_URL}"
  l1_rpc="${L1_RPC:-}"
  # Trim only. An empty token sends no Authorization header. Never print it.
  l1_auth="$(printf '%s' "${L1_RPC_AUTH_TOKEN:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # The Compose hostname is not resolvable from the host; Anvil is published on loopback.
  [[ "$l1_rpc" == "http://l1:8545" ]] && l1_rpc="http://127.0.0.1:${L1_RPC_PORT:-8545}"

  if http_ok "$node_url"; then
    ok "  Node        reachable — $node_url"
  else
    warn "  Node        not reachable — $node_url"
  fi

  if http_ok "$l2_url"; then
    ok "  L2 operator reachable — $l2_url"
  else
    warn "  L2 operator not reachable — $l2_url"
  fi

  if [[ -z "$l1_rpc" ]]; then
    echo "  L1_RPC      (unset — civic votes cannot be published; polls still work)"
  elif rpc_ok "$l1_rpc" "$l1_auth" || http_ok "$l1_rpc" "$l1_auth"; then
    ok "  L1_RPC      reachable — $(redact_rpc "$l1_rpc")"
  else
    warn "  L1_RPC      not reachable — $(redact_rpc "$l1_rpc")"
  fi

  echo
  echo "  The rollup address is ROLLUP_ADDRESS (or ROLLUP_DEPLOYMENT_FILE) in .env."
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
    warn "no zk-voting.json yet — start the Node once, or use launch (option 1)"
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
  echo "  Dev login is POST /api/auth/dev-login when ALLOW_DEV_LOGIN=1"
  echo "  (ignored when NODE_ENV=production). Local users: ./system_actions.sh 7"
  echo
}


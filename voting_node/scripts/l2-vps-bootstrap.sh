#!/usr/bin/env bash
# Bring up the zk-voting L2 on a new server. Generic and env-driven: it names
# no host, provider or operator. Run it from a checkout on the new server.
#
#   ./scripts/l2-vps-bootstrap.sh check       prerequisites, env and L1 record (read-only)
#   ./scripts/l2-vps-bootstrap.sh env         write the L2 settings into .env from the L1 record
#   ./scripts/l2-vps-bootstrap.sh up          docker compose up the l2 (+ prover) services
#   ./scripts/l2-vps-bootstrap.sh deploy-l2   deploy the election stack to the new L2 RPC
#                                             through ZkVotingDeployer (deploy.sh --via-deployer)
#   ./scripts/l2-vps-bootstrap.sh health      L2 RPC /health, chain id, L1 settlement code
#   ./scripts/l2-vps-bootstrap.sh all         check, env, up, health, deploy-l2, health
#
# Inputs (env or .env):
#   L1_RPC                  L1 JSON-RPC (read for health checks; nothing is sent)
#   L1_DEPLOYMENTS_FILE     the L1 record from deploy.sh (default deployments/<L1_CHAIN_ID>.json)
#   L1_CHAIN_ID             default: read from L1_RPC
#   L2_RPC_PORT, L2_RPC_BIND, L2_BATCH_SIZE, L2_ADMISSION, ...   see .env.example
#   L2_OPERATOR_ADDRESS     sequencer / operator account
#   L1_SUBMITTER_PRIVATE_KEY  batch submitter key; set it in your secret store, never in git
#   L2_DEPLOY_RPC_URL       RPC the election stack is deployed to (default http://127.0.0.1:$L2_RPC_PORT)
#   ADMIN                   final admin of the L2 modules (multisig recommended)
#   DRY_RUN=1               simulate deploy-l2 only
#   L2_ENV_FILE             file the env step writes (default .env)
#
# This script provisions nothing: no server, DNS, firewall or TLS. It never
# prints secrets.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_repo_env

ENV_FILE="${L2_ENV_FILE:-$REPO_ROOT/.env}"
L2_PORT="${L2_RPC_PORT:-8546}"
L2_LOCAL_RPC="http://127.0.0.1:${L2_PORT}"

l1_chain_id() {
  if [[ -n "${L1_CHAIN_ID:-}" ]]; then echo "$L1_CHAIN_ID"; return; fi
  [[ -n "${L1_RPC:-}" ]] || die "set L1_RPC (or L1_CHAIN_ID) in the environment or .env"
  cast chain-id --rpc-url "$L1_RPC" 2>/dev/null || die "no answer from L1_RPC $(redact_url "$L1_RPC")"
}

l1_record() { echo "${L1_DEPLOYMENTS_FILE:-$REPO_ROOT/deployments/$(l1_chain_id).json}"; }

record_get() {
  python3 - "$1" "$2" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print((r.get("addresses") or {}).get(sys.argv[2], ""))
PY
}

cmd_check() {
  local ok=1
  for bin in docker cast forge python3 curl; do
    if command -v "$bin" >/dev/null 2>&1; then info "ok   $bin"; else warn "missing $bin"; ok=0; fi
  done
  docker compose version >/dev/null 2>&1 && info "ok   docker compose" || { warn "missing docker compose plugin"; ok=0; }
  [[ -f "$ENV_FILE" ]] && info "ok   $ENV_FILE" || warn "no $ENV_FILE yet (run: $0 env)"
  local rec; rec="$(l1_record)"
  if [[ -f "$rec" ]]; then
    info "ok   L1 record $rec"
    local s; s="$(record_get "$rec" SETTLEMENT_ADDRESS)"
    [[ -n "$s" ]] && info "     SETTLEMENT_ADDRESS=$s" || { warn "L1 record has no SETTLEMENT_ADDRESS"; ok=0; }
  else
    warn "no L1 record at $rec. Copy deployments/<chainId>.json from the L1 deploy, or set L1_DEPLOYMENTS_FILE."
    ok=0
  fi
  for k in L2_OPERATOR_ADDRESS L1_SUBMITTER_PRIVATE_KEY; do
    [[ -n "${!k:-}" ]] && info "ok   $k is set" || warn "$k is not set"
  done
  [[ "$ok" -eq 1 ]] || die "prerequisites missing (see warnings above)"
}

set_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys
p, k, v = sys.argv[1:]
lines = open(p).read().splitlines()
lines = [f"{k}={v}" if l.startswith(k + "=") else l for l in lines]
open(p, "w").write("\n".join(lines) + "\n")
PY
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
  info "  $key=$val"
}

cmd_env() {
  local rec; rec="$(l1_record)"
  [[ -f "$rec" ]] || die "no L1 record at $rec"
  info "writing L2 settings to $ENV_FILE from $rec"
  for k in SETTLEMENT_ADDRESS L1_SETTLEMENT_ADDRESS L1_TALLY_MIRROR_ADDRESS; do
    local v; v="$(record_get "$rec" "$k")"
    [[ -n "$v" ]] && set_env "$k" "$v"
  done
  set_env L1_CHAIN_ID "$(l1_chain_id)"
  [[ -n "${L2_RPC_PORT:-}" ]] || set_env L2_RPC_PORT 8546
  [[ -n "${L2_RPC_BIND:-}" ]] || set_env L2_RPC_BIND 127.0.0.1
  info "secrets (L1_SUBMITTER_PRIVATE_KEY, L2_ADMIN_SECRET) are not written; keep them in your secret store."
}

cmd_up() {
  (cd "$REPO_ROOT" && docker compose up -d l2 prover)
}

cmd_health() {
  local fail=0
  if curl -fsS "$L2_LOCAL_RPC/health" >/dev/null 2>&1; then info "ok   L2 /health at $L2_LOCAL_RPC"; else warn "L2 /health not answering at $L2_LOCAL_RPC"; fail=1; fi
  local cid; cid="$(cast chain-id --rpc-url "$L2_LOCAL_RPC" 2>/dev/null || true)"
  [[ -n "$cid" ]] && info "ok   L2 chain id $cid" || { warn "L2 RPC does not answer eth_chainId"; fail=1; }
  if [[ -n "${L1_RPC:-}" ]]; then
    local s="${SETTLEMENT_ADDRESS:-}"
    [[ -z "$s" && -f "$(l1_record)" ]] && s="$(record_get "$(l1_record)" SETTLEMENT_ADDRESS)"
    if [[ -n "$s" && "$(cast code "$s" --rpc-url "$L1_RPC" 2>/dev/null || echo 0x)" != "0x" ]]; then
      info "ok   L1 settlement $s has code"
    else
      warn "L1 settlement ${s:-<unset>} has no code on L1"; fail=1
    fi
  fi
  return "$fail"
}

cmd_deploy_l2() {
  local rpc="${L2_DEPLOY_RPC_URL:-$L2_LOCAL_RPC}"
  local args=(--target l2 --via-deployer --rpc-url "$rpc")
  is_truthy "${DRY_RUN:-0}" && args+=(--dry-run)
  [[ -n "${ZK_VOTING_CODE_SIZE_LIMIT:-}" ]] && args+=(--code-size-limit "$ZK_VOTING_CODE_SIZE_LIMIT")
  "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "${args[@]}"
  is_truthy "${DRY_RUN:-0}" && return 0
  local l2cid l2rec factory mirror
  l2cid="$(cast chain-id --rpc-url "$rpc")"
  l2rec="$REPO_ROOT/deployments/$l2cid.json"
  factory="$(record_get "$l2rec" ELECTION_FACTORY_ADDRESS)"
  mirror="$(record_get "$(l1_record)" L1_TALLY_MIRROR_ADDRESS 2>/dev/null || true)"
  if [[ -n "$factory" && -n "$mirror" ]]; then
    info ""
    info "L1 admin: pin the new L2 factory in the tally mirror (once; first write wins):"
    info "  to=$mirror data=$(cast calldata 'setL2Factory(address)' "$factory")"
  fi
}

case "${1:-check}" in
  check) cmd_check ;;
  env) cmd_env ;;
  up) cmd_up ;;
  health) cmd_health ;;
  deploy-l2) cmd_deploy_l2 ;;
  all) cmd_check; cmd_env; cmd_up; sleep "${L2_BOOT_WAIT_SECONDS:-10}"; cmd_health || true; cmd_deploy_l2; cmd_health ;;
  -h | --help) sed -n '2,27p' "$0" ;;
  *) die "unknown command '$1' (check|env|up|deploy-l2|health|all)" ;;
esac

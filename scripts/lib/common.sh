#!/usr/bin/env bash
# Shared helpers for scripts/*.sh. Source it; do not run it.
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# Nothing here names a host, node, or API key. Every endpoint comes from the
# environment, a flag, or the repo .env file.

# shellcheck disable=SC2034  # REPO_ROOT and SC_DIR are used by the callers.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SC_DIR="$REPO_ROOT/smart-contracts"

# Foundry installs to ~/.foundry/bin; add it when it is not on PATH yet.
if [[ -d "${HOME:-/nonexistent}/.foundry/bin" ]]; then
  case ":$PATH:" in
    *":$HOME/.foundry/bin:"*) ;;
    *) PATH="$HOME/.foundry/bin:$PATH" ;;
  esac
fi

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

info() {
  printf '%s\n' "$*" >&2
}

have() {
  command -v "$1" >/dev/null 2>&1
}

need() {
  local cmd="$1" hint="${2:-}"
  have "$cmd" || die "'$cmd' is required but not installed.${hint:+ $hint}"
}

FOUNDRY_HINT="Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup (see https://book.getfoundry.sh/getting-started/installation)"

# load_env_file FILE
# Reads KEY=VALUE lines without executing the file. Variables that are
# already set in the environment win, so `L1_RPC=... ./scripts/x.sh` and
# flags always override .env.
load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line#export }"
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    else
      # Strip a trailing " # comment" on unquoted values.
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
    if [[ -z "${!key+x}" ]]; then
      printf -v "$key" '%s' "$value"
      export "${key?}"
    fi
  done <"$file"
}

# Load the repo .env (or ENV_FILE) once. Missing file is fine.
load_repo_env() {
  local file="${ENV_FILE:-$REPO_ROOT/.env}"
  if [[ -n "${ENV_FILE:-}" && ! -f "$ENV_FILE" ]]; then
    die "ENV_FILE=$ENV_FILE does not exist"
  fi
  load_env_file "$file"
}

# redact_url URL -> scheme://host[:port]/… with no path, query, or userinfo.
# RPC URLs often carry an API key in the path or query; never print those.
redact_url() {
  local url="$1" rest scheme hostport
  if [[ "$url" != *://* ]]; then
    printf '%s' "$url"
    return 0
  fi
  scheme="${url%%://*}"
  rest="${url#*://}"
  hostport="${rest%%/*}"
  hostport="${hostport%%\?*}"
  hostport="${hostport##*@}"
  if [[ "$rest" == "$hostport" ]]; then
    printf '%s://%s' "$scheme" "$hostport"
  else
    printf '%s://%s/…' "$scheme" "$hostport"
  fi
}

# rpc_call URL METHOD [PARAMS_JSON] -> prints .result, non-zero on failure.
rpc_call() {
  local url="$1" method="$2" params="${3:-[]}" body
  need curl
  body="$(curl -fsS --connect-timeout "${RPC_CONNECT_TIMEOUT:-5}" --max-time "${RPC_TIMEOUT:-15}" \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" \
    "$url" 2>/dev/null)" || return 1
  if have jq; then
    printf '%s' "$body" | jq -er '.result // empty | if type=="string" then . else tojson end' 2>/dev/null
  else
    printf '%s' "$body" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p' | grep .
  fi
}

# hex_to_dec 0x... -> decimal string (arbitrary size).
hex_to_dec() {
  local h="${1#0x}"
  if have python3; then
    python3 -c 'import sys; print(int(sys.argv[1] or "0", 16))' "$h"
  elif have cast; then
    cast to-dec "0x$h"
  else
    printf '%d\n' "0x$h"
  fi
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

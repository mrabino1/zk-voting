# NOT FOR PROFIT — civic public good, not a commercial product.
# Shared environment, branch policy, and helpers for system_actions.sh

: "${ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

# Load KEY=value lines from a dotenv file. Bash cannot export names that
# start with a digit; those are skipped (the Node app still reads them).
load_dotenv_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" != *"="* ]] && continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]}"}"
    if [[ "$val" == \"*\" ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "$val" == \'*\' ]]; then
      val="${val:1:${#val}-2}"
    fi
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "${key}=${val}"
  done < "$env_file"
}

source_project_env() {
  # Optional parent-directory .env, then this repo's .env, then .env.local.
  load_dotenv_file "$ROOT/../.env"
  load_dotenv_file "$ROOT/.env"
  load_dotenv_file "$ROOT/.env.local"
}

source_project_env

# Branch policy: feature/* → test/unstable (integration) → master (release).
DEV_BRANCH="${ZK_VOTING_DEV_BRANCH:-test/unstable}"
PROD_BRANCH="${ZK_VOTING_PROD_BRANCH:-master}"
INTEGRATION_BRANCH="${ZK_VOTING_INTEGRATION_BRANCH:-$DEV_BRANCH}"
RELEASE_BRANCH="${ZK_VOTING_RELEASE_BRANCH:-$PROD_BRANCH}"
APP_NAME="${ZK_VOTING_APP_NAME:-zk-voting}"
LOG_LINES="${ZK_VOTING_LOG_LINES:-80}"
PM2_NAME="${ZK_VOTING_PM2_NAME:-$APP_NAME}"
SYSTEMD_UNIT="${ZK_VOTING_SYSTEMD_UNIT:-$APP_NAME}"
HEALTH_URL="${ZK_VOTING_HEALTH_URL:-http://127.0.0.1:${ZK_VOTING_PORT:-3000}/health}"
L2_HEALTH_URL="${ZK_VOTING_L2_HEALTH_URL:-http://127.0.0.1:${L2_RPC_PORT:-8546}/health}"
DATA_DIR="${DATA_DIR:-$ROOT/apps/node/data}"
STORE_FILE="${ZK_VOTING_STORE_FILE:-$DATA_DIR/republic.json}"

RED=$'\033[31m'
GRN=$'\033[32m'
YLW=$'\033[33m'
CYN=$'\033[36m'
BLD=$'\033[1m'
RST=$'\033[0m'

info() { printf '%s%s%s\n' "$CYN" "$*" "$RST"; }
ok()   { printf '%s%s%s\n' "$GRN" "$*" "$RST"; }
warn() { printf '%s%s%s\n' "$YLW" "$*" "$RST"; }
err()  { printf '%s%s%s\n' "$RED" "$*" "$RST" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    err "missing required command: $1"
    exit 1
  }
}

current_branch() {
  git rev-parse --abbrev-ref HEAD
}

current_sha() {
  git rev-parse --short HEAD 2>/dev/null || echo "none"
}

working_tree_dirty() {
  ! git diff --quiet || ! git diff --cached --quiet
}

confirm() {
  local prompt="$1"
  local reply
  printf '%s%s%s ' "$YLW" "$prompt [y/N]" "$RST"
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

git_default_remote() {
  git config "branch.${INTEGRATION_BRANCH}.remote" 2>/dev/null \
    || git config "branch.${RELEASE_BRANCH}.remote" 2>/dev/null \
    || git config branch.master.remote 2>/dev/null \
    || echo "origin"
}

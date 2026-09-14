#!/usr/bin/env bash
# system_actions.sh — host/operator menu for zk-voting
#
# Adapted from the DealPunchList (dealpunchlist-node) system_actions
# pattern: one script to inspect, pull, build, and restart the app,
# with a hard split between the development line and production.
#
# Branch policy
#   test/unstable  default development / staging line
#   master         production only
#
# Usage
#   ./system_actions.sh              interactive menu
#   ./system_actions.sh help
#   ./system_actions.sh status
#   ./system_actions.sh deploy-dev
#   ./system_actions.sh deploy-prod
#   ./system_actions.sh restart
#   ./system_actions.sh logs
#   ./system_actions.sh health
#   ./system_actions.sh checkout-dev
#   ./system_actions.sh checkout-prod

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DEV_BRANCH="${ZK_VOTING_DEV_BRANCH:-test/unstable}"
PROD_BRANCH="${ZK_VOTING_PROD_BRANCH:-master}"
APP_NAME="${ZK_VOTING_APP_NAME:-zk-voting}"
HEALTH_URL="${ZK_VOTING_HEALTH_URL:-http://127.0.0.1:${ZK_VOTING_PORT:-3000}/health}"
LOG_LINES="${ZK_VOTING_LOG_LINES:-80}"
PM2_NAME="${ZK_VOTING_PM2_NAME:-$APP_NAME}"
SYSTEMD_UNIT="${ZK_VOTING_SYSTEMD_UNIT:-$APP_NAME}"

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

package_manager() {
  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    echo pnpm
  elif [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
    echo yarn
  elif [[ -f bun.lockb || -f bun.lock ]] && command -v bun >/dev/null 2>&1; then
    echo bun
  elif [[ -f package.json ]]; then
    echo npm
  else
    echo none
  fi
}

install_deps() {
  local pm
  pm="$(package_manager)"
  case "$pm" in
    pnpm) info "installing with pnpm"; pnpm install --frozen-lockfile ;;
    yarn) info "installing with yarn"; yarn install --frozen-lockfile ;;
    bun)  info "installing with bun"; bun install --frozen-lockfile ;;
    npm)
      info "installing with npm"
      if [[ -f package-lock.json ]]; then
        npm ci
      else
        npm install
      fi
      ;;
    none)
      warn "no package.json yet — skipping dependency install"
      ;;
  esac
}

run_build() {
  local pm
  pm="$(package_manager)"
  [[ "$pm" == "none" ]] && { warn "no package.json yet — skipping build"; return 0; }
  if python3 - "$ROOT/package.json" <<'PY' >/dev/null 2>&1
import json,sys
p=json.load(open(sys.argv[1]))
raise SystemExit(0 if (p.get("scripts") or {}).get("build") else 1)
PY
  then
    info "running $pm run build"
    "$pm" run build
  else
    warn "no build script — skipping"
  fi
}

has_pm2() {
  command -v pm2 >/dev/null 2>&1
}

has_systemd_unit() {
  command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1
}

has_compose() {
  [[ -f docker-compose.yml || -f docker-compose.yaml || -f compose.yml || -f compose.yaml ]]
}

compose_cmd() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo docker-compose
  else
    echo ""
  fi
}

restart_services() {
  if has_pm2; then
    info "restarting pm2 process: $PM2_NAME"
    if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
      pm2 reload "$PM2_NAME" --update-env || pm2 restart "$PM2_NAME" --update-env
    elif [[ -f ecosystem.config.cjs || -f ecosystem.config.js ]]; then
      local eco
      [[ -f ecosystem.config.cjs ]] && eco=ecosystem.config.cjs || eco=ecosystem.config.js
      pm2 startOrReload "$eco" --update-env
    else
      warn "pm2 is installed but $PM2_NAME is not registered yet"
    fi
    return 0
  fi

  if has_systemd_unit; then
    info "restarting systemd unit: $SYSTEMD_UNIT"
    sudo systemctl restart "$SYSTEMD_UNIT"
    sudo systemctl --no-pager --full status "$SYSTEMD_UNIT" | sed -n '1,12p'
    return 0
  fi

  local dc
  dc="$(compose_cmd)"
  if has_compose && [[ -n "$dc" ]]; then
    info "restarting docker compose services"
    $dc up -d --build
    return 0
  fi

  warn "no pm2 / systemd unit / docker compose target found — process not restarted"
}

show_logs() {
  if has_pm2; then
    pm2 logs "$PM2_NAME" --lines "$LOG_LINES" --nostream
    return 0
  fi
  if has_systemd_unit; then
    sudo journalctl -u "$SYSTEMD_UNIT" -n "$LOG_LINES" --no-pager
    return 0
  fi
  local dc
  dc="$(compose_cmd)"
  if has_compose && [[ -n "$dc" ]]; then
    $dc logs --tail="$LOG_LINES"
    return 0
  fi
  warn "no process manager logs available yet"
}

git_sync() {
  local branch="$1"
  need git
  info "fetching origin"
  git fetch origin "$branch"
  if [[ "$(current_branch)" != "$branch" ]]; then
    info "checking out $branch"
    git checkout "$branch"
  fi
  info "fast-forwarding $branch from origin"
  git pull --ff-only origin "$branch"
  ok "now on $(current_branch) @ $(current_sha)"
}

deploy() {
  local branch="$1"
  local label="$2"
  if working_tree_dirty; then
    err "working tree is dirty — commit or stash before deploying $label"
    git status --short
    exit 1
  fi
  git_sync "$branch"
  if [[ "$(current_branch)" != "$branch" ]]; then
    err "refusing to continue: expected $branch, on $(current_branch)"
    exit 1
  fi
  install_deps
  run_build
  restart_services
  ok "$label deploy complete: $(current_branch) @ $(current_sha)"
}

cmd_status() {
  printf '%s%s%s\n' "$BLD" "zk-voting status" "$RST"
  echo "  repo      $ROOT"
  echo "  branch    $(current_branch)"
  echo "  commit    $(current_sha) $(git log -1 --pretty=%s 2>/dev/null || true)"
  echo "  dirty     $(working_tree_dirty && echo yes || echo no)"
  echo "  origin    $(git remote get-url origin 2>/dev/null | sed -E 's#://[^@/]+@#://#' || echo none)"
  echo "  dev line  $DEV_BRANCH"
  echo "  prod line $PROD_BRANCH"
  echo "  pkg mgr   $(package_manager)"
  if has_pm2; then
    echo "  runtime   pm2 ($PM2_NAME)"
    pm2 describe "$PM2_NAME" >/dev/null 2>&1 && pm2 describe "$PM2_NAME" | sed -n '1,20p' || warn "  pm2 process not started"
  elif has_systemd_unit; then
    echo "  runtime   systemd ($SYSTEMD_UNIT)"
    systemctl is-active "$SYSTEMD_UNIT" || true
  elif has_compose; then
    echo "  runtime   docker compose"
    local dc
    dc="$(compose_cmd)"
    [[ -n "$dc" ]] && $dc ps || true
  else
    echo "  runtime   not configured yet"
  fi
}

cmd_health() {
  info "GET $HEALTH_URL"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 "$HEALTH_URL"; then
      echo
      ok "health check passed"
    else
      warn "health check failed (service may not be running yet)"
      return 1
    fi
  else
    err "curl is not installed"
    return 1
  fi
}

cmd_deploy_dev() {
  info "deploying DEVELOPMENT from $DEV_BRANCH"
  deploy "$DEV_BRANCH" "development"
}

cmd_deploy_prod() {
  warn "PRODUCTION deploy from $PROD_BRANCH"
  if [[ "${1:-}" != "--yes" ]]; then
    confirm "This will fast-forward $PROD_BRANCH and restart $APP_NAME. Continue?" || {
      info "aborted"
      return 1
    }
  fi
  deploy "$PROD_BRANCH" "production"
}

cmd_help() {
  cat <<EOF
${BLD}zk-voting system_actions.sh${RST}

Development happens on ${CYN}${DEV_BRANCH}${RST}.
Production is ${CYN}${PROD_BRANCH}${RST} only.

Commands
  help            this text
  status          git + runtime snapshot
  checkout-dev    fetch and check out $DEV_BRANCH
  checkout-prod   fetch and check out $PROD_BRANCH
  deploy-dev      pull $DEV_BRANCH, install, build, restart
  deploy-prod     pull $PROD_BRANCH, install, build, restart (confirms)
  restart         reload pm2 / systemd / compose
  logs            last ${LOG_LINES} log lines
  health          GET ${HEALTH_URL}

Environment overrides
  ZK_VOTING_DEV_BRANCH   ZK_VOTING_PROD_BRANCH
  ZK_VOTING_APP_NAME     ZK_VOTING_PM2_NAME
  ZK_VOTING_SYSTEMD_UNIT ZK_VOTING_HEALTH_URL
  ZK_VOTING_PORT          ZK_VOTING_LOG_LINES
EOF
}

menu() {
  while true; do
    echo
    printf '%s%s%s\n' "$BLD" "zk-voting system actions" "$RST"
    echo "  now: $(current_branch) @ $(current_sha)"
    echo "  1) status"
    echo "  2) checkout $DEV_BRANCH (development)"
    echo "  3) deploy $DEV_BRANCH (development)"
    echo "  4) checkout $PROD_BRANCH (production)"
    echo "  5) deploy $PROD_BRANCH (PRODUCTION)"
    echo "  6) restart services"
    echo "  7) logs"
    echo "  8) health"
    echo "  9) help"
    echo "  0) exit"
    printf 'select> '
    local choice
    read -r choice || exit 0
    case "$choice" in
      1) cmd_status ;;
      2) git_sync "$DEV_BRANCH" ;;
      3) cmd_deploy_dev ;;
      4) git_sync "$PROD_BRANCH" ;;
      5) cmd_deploy_prod ;;
      6) restart_services ;;
      7) show_logs ;;
      8) cmd_health || true ;;
      9) cmd_help ;;
      0) exit 0 ;;
      *) warn "unknown selection: $choice" ;;
    esac
  done
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    "" ) menu ;;
    help|-h|--help) cmd_help ;;
    status) cmd_status ;;
    checkout-dev) git_sync "$DEV_BRANCH" ;;
    checkout-prod) git_sync "$PROD_BRANCH" ;;
    deploy-dev) cmd_deploy_dev ;;
    deploy-prod) cmd_deploy_prod "${1:-}" ;;
    restart) restart_services ;;
    logs) show_logs ;;
    health) cmd_health ;;
    *)
      err "unknown command: $cmd"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"

#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
# system_actions.sh — host/operator menu for zk-voting
#
# Branch policy
#   feature/*      short-lived work
#   test/unstable  default development / staging line
#   master         production only
#
# Usage
#   ./system_actions.sh              interactive menu
#   ./system_actions.sh help
#   ./system_actions.sh 1            launch test system (pull + npm run dev)
#   ./system_actions.sh 2 my-feature create feature/* from test/unstable
#   ./system_actions.sh 3            merge feature/* into test/unstable
#   ./system_actions.sh 4            merge test/unstable into master
#   ./system_actions.sh status
#   ./system_actions.sh deploy-dev
#   ./system_actions.sh deploy-prod

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

_LIB_DIR="$ROOT/system_actions/lib"
# shellcheck source=system_actions/lib/env.sh
source "$_LIB_DIR/env.sh"
# shellcheck source=system_actions/lib/services.sh
source "$_LIB_DIR/services.sh"

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
    if docker info >/dev/null 2>&1; then
      echo "docker compose"
      return 0
    fi
    if sudo -n docker info >/dev/null 2>&1; then
      echo "sudo docker compose"
      return 0
    fi
    echo "docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo docker-compose
    return 0
  fi
  echo ""
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
  local remote
  remote="$(git_default_remote)"
  info "fetching $remote"
  git fetch "$remote" "$branch"
  if [[ "$(current_branch)" != "$branch" ]]; then
    info "checking out $branch"
    git checkout "$branch"
  fi
  info "fast-forwarding $branch from $remote"
  git pull --ff-only "$remote" "$branch"
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
  echo "  store     $STORE_FILE"
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

cmd_archive() {
  need node
  info "L2 hourly archive (attic). Sequencer hot path stays local."
  node "$ROOT/l2/archive/cli.mjs" archive
}

cmd_archive_restore() {
  need node
  node "$ROOT/l2/archive/cli.mjs" restore "$@"
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

# shellcheck source=system_actions/lib/git-flow.sh
source "$_LIB_DIR/git-flow.sh"

cmd_help() {
  cat <<EOF
${BLD}zk-voting system_actions.sh${RST}

Development happens on ${CYN}${DEV_BRANCH}${RST} (feature/* merges here).
Production is ${CYN}${PROD_BRANCH}${RST} only.

Git workflow
  1, launch, --launch-test-system
                  fetch + pull, npm install, npm run dev
  2, create-feature, --create-feature [name]
                  create feature/* from $DEV_BRANCH
  3, merge-feature, --merge-feature
                  merge feature/* into $DEV_BRANCH and push
  4, merge-to-master, --merge-to-master
                  merge $DEV_BRANCH into $PROD_BRANCH (type MERGE)

Data / chain (JSON store, no SQL database)
  5, data, --data-status
                  republic.json counts
  6, connectivity
                  Node / L2 / CHAIN_RPC / L1_RPC reachability
  7, users, --list-users
                  local Node handles + roles (no emails)
  dev-flags       ALLOW_DEV_LOGIN and mock flags

Host / operator
  help            this text
  status          git + runtime snapshot
  checkout-dev    fetch and check out $DEV_BRANCH
  checkout-prod   fetch and check out $PROD_BRANCH
  deploy-dev      pull $DEV_BRANCH, install, build, restart
  deploy-prod     pull $PROD_BRANCH, install, build, restart (confirms)
  restart         reload pm2 / systemd / compose
  logs            last ${LOG_LINES} log lines
  health          GET ${HEALTH_URL}
  archive         hourly L2 attic (on by default; no delete without a bucket or file:// sink)
  archive-restore restore one sealed hour from S3/R2 (read-only)

Environment overrides
  ZK_VOTING_DEV_BRANCH   ZK_VOTING_PROD_BRANCH
  ZK_VOTING_APP_NAME     ZK_VOTING_PM2_NAME
  ZK_VOTING_SYSTEMD_UNIT ZK_VOTING_HEALTH_URL
  ZK_VOTING_PORT          ZK_VOTING_LOG_LINES
  ZK_VOTING_HOST          ZK_VOTING_L2_HEALTH_URL
EOF
}

menu() {
  while true; do
    echo
    printf '%s%s%s\n' "$BLD" "zk-voting system actions" "$RST"
    echo "  now: $(current_branch) @ $(current_sha)"
    echo
    echo "  Git workflow"
    echo "    1) launch test system (pull + npm run dev)"
    echo "    2) create feature branch from $DEV_BRANCH"
    echo "    3) merge feature/* into $DEV_BRANCH"
    echo "    4) merge $DEV_BRANCH → $PROD_BRANCH and push"
    echo
    echo "  Data / chain"
    echo "    5) JSON store status"
    echo "    6) connectivity (Node / L2 / chain)"
    echo "    7) list local Node users (handle + role)"
    echo "    v) dev-only flags (ALLOW_DEV_LOGIN / mocks)"
    echo
    echo "  Host"
    echo "    s) status"
    echo "    c) checkout $DEV_BRANCH"
    echo "    d) deploy $DEV_BRANCH"
    echo "    m) checkout $PROD_BRANCH"
    echo "    p) deploy $PROD_BRANCH (PRODUCTION)"
    echo "    r) restart services"
    echo "    l) logs"
    echo "    k) health"
    echo "    a) L2 archive offload (hourly attic)"
    echo "    h) help"
    echo "    0) exit"
    printf 'select> '
    local choice
    read -r choice || exit 0
    case "$choice" in
      1) launch_test_system ;;
      2) create_feature_branch ;;
      3) merge_feature_to_main ;;
      4) merge_to_release ;;
      5) cmd_data_status ;;
      6) cmd_connectivity ;;
      7) cmd_list_users ;;
      v|V) cmd_dev_flags ;;
      s|S) cmd_status ;;
      c) git_sync "$DEV_BRANCH" ;;
      d) cmd_deploy_dev ;;
      m) git_sync "$PROD_BRANCH" ;;
      p) cmd_deploy_prod ;;
      r) restart_services ;;
      l) show_logs ;;
      k) cmd_health || true ;;
      a) cmd_archive || true ;;
      h|H|\?) cmd_help ;;
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
    1|--launch-test-system|launch|launch-test) launch_test_system ;;
    2|--create-feature|create-feature) create_feature_branch "${1:-}" ;;
    3|--merge-feature|merge-feature) merge_feature_to_main ;;
    4|--merge-to-master|--merge-to-release|merge-to-master|merge-to-release) merge_to_release ;;
    5|--data-status|data) cmd_data_status ;;
    6|connectivity) cmd_connectivity ;;
    7|--list-users|users) cmd_list_users "${1:-}" ;;
    dev-flags|--dev-flags) cmd_dev_flags ;;
    status) cmd_status ;;
    checkout-dev) git_sync "$DEV_BRANCH" ;;
    checkout-prod) git_sync "$PROD_BRANCH" ;;
    deploy-dev) cmd_deploy_dev ;;
    deploy-prod) cmd_deploy_prod "${1:-}" ;;
    restart) restart_services ;;
    logs) show_logs ;;
    health) cmd_health ;;
    archive) cmd_archive ;;
    archive-restore) cmd_archive_restore "$@" ;;
    *)
      err "unknown command: $cmd"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"

#!/usr/bin/env bash
# Production-image boot check.
#
# This repository has no SQL migrations. `migrations` is a no-op that
# fails closed if a .sql file appears, so a later migration cannot skip
# the check silently.
#
# Usage (from anywhere):
#   ./scripts/migrations-verify.sh              # no-op + production build + boot smoke
#   ./scripts/migrations-verify.sh migrations   # no-op SQL search only
#   ./scripts/migrations-verify.sh build        # npm run build
#   ./scripts/migrations-verify.sh smoke        # docker build + boot + /health
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-zk-voting-node:migrations-verify}"
NAME="${NAME:-zk-voting-migrations-verify}"
NET="${NET:-zk-voting-migrations-verify}"
SMOKE_PORT="${SMOKE_PORT:-18080}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
MEMORY_CAP="384m"
# Set for the lifetime of the process so the EXIT trap can still see it.
SMOKE_STARTED=0

usage() {
  echo "usage: $0 [all|migrations|build|smoke]" >&2
}

# NO-OP migrations. There is no journal, no runner, and no schema fixture.
cmd_migrations() {
  echo "NO-OP: this repository has no SQL migrations."
  local -a sql_files=()
  local f
  while IFS= read -r -d '' f; do
    sql_files+=("$f")
  done < <(find . -type f -name '*.sql' \
    -not -path './.git/*' \
    -not -path './*/node_modules/*' \
    -not -path './node_modules/*' \
    -print0)

  if ((${#sql_files[@]} > 0)); then
    echo "ERROR: SQL files are present, but migrations-verify is still a no-op." >&2
    echo "Add a real migration journal check before merging these files:" >&2
    printf '  %s\n' "${sql_files[@]}" >&2
    exit 1
  fi

  echo "Searched the tree for *.sql (excluding .git and node_modules): none found."
  echo "There is no migration journal to check, nothing to apply, and no schema fixture to restore."
  echo "NO-OP: a second apply is not run because there is no migration runner."
  echo "Re-running this step is idempotent: it only repeats the file search."
}

cmd_build() {
  echo "== production build (npm run build) =="
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required for the production build." >&2
    exit 1
  fi
  npm run build
}

report_memory() {
  local note="$1"
  local stats
  stats="$(docker stats --no-stream --format 'name={{.Name}} mem={{.MemUsage}} perc={{.MemPerc}}' "$NAME" 2>/dev/null || true)"
  echo "Memory: ${note}"
  if [[ -n "$stats" ]]; then
    echo "$stats"
  else
    echo "docker stats unavailable for ${NAME}"
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "## migrations-verify"
      echo
      echo "SQL migrations: none (no-op)."
      echo
      echo "Memory: ${note}"
      echo
      if [[ -n "$stats" ]]; then
        echo '```'
        echo "$stats"
        echo '```'
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

cmd_smoke() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required for the production image boot smoke." >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required to call /health." >&2
    exit 1
  fi

  cleanup() {
    local code=$?
    if [[ "$SMOKE_STARTED" == 1 && "$code" -ne 0 ]]; then
      echo "==== ${NAME} logs ===="
      docker logs "$NAME" 2>&1 || true
      echo "==== ${NAME} state ===="
      docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' "$NAME" 2>/dev/null || true
    fi
    if [[ "$SMOKE_STARTED" == 1 ]]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker network rm "$NET" >/dev/null 2>&1 || true
    fi
    exit "$code"
  }
  trap cleanup EXIT

  echo "== docker build (${IMAGE}) =="
  docker build -f Dockerfile -t "$IMAGE" "$ROOT"

  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  SMOKE_STARTED=1
  docker network create "$NET" >/dev/null

  local -a mem_args=()
  local mem_note mem_limit swap_limit
  mem_limit="$(docker info --format '{{.MemoryLimit}}' 2>/dev/null || echo false)"
  swap_limit="$(docker info --format '{{.SwapLimit}}' 2>/dev/null || echo false)"
  if [[ "$mem_limit" == "true" && "$swap_limit" == "true" ]]; then
    mem_args=(--memory="$MEMORY_CAP" --memory-swap="$MEMORY_CAP")
    mem_note="cap ${MEMORY_CAP} (no swap)"
  elif [[ "$mem_limit" == "true" ]]; then
    mem_args=(--memory="$MEMORY_CAP")
    mem_note="cap ${MEMORY_CAP} RAM; swap limit not available on this daemon"
    echo "WARNING: ${mem_note}"
  else
    mem_note="384MB cap not feasible on this daemon (MemoryLimit=${mem_limit}); booted without a cap"
    echo "WARNING: ${mem_note}"
  fi

  # Empty secret env is intentional: the process must boot without operator keys.
  run_container() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d \
      --name "$NAME" \
      --network "$NET" \
      --init \
      "$@" \
      -p "127.0.0.1:${SMOKE_PORT}:3000" \
      -e NODE_ENV=production \
      -e HOST=0.0.0.0 \
      -e PORT=3000 \
      -e DATA_DIR=/data \
      -e CHAIN_ID=27427 \
      -e CHAIN_RPC= \
      -e L1_RPC= \
      -e L1_RPC_URL= \
      -e L1_PUBLISHER_PRIVATE_KEY= \
      -e L1_PRIVATE_KEY= \
      -e RELAYER_PRIVATE_KEY= \
      -e SUPER_ADMIN_EMAIL= \
      -e AWS_ACCESS_KEY_ID= \
      -e AWS_SECRET_ACCESS_KEY= \
      -e AWS_SESSION_TOKEN= \
      -e AWS_REGION= \
      -e SES_FROM_ADDRESS= \
      -e SES_DRY_RUN=1 \
      -e ALLOW_DEV_LOGIN= \
      -e CREDENTIAL_PROVIDER_SECRET= \
      -e RECEIPT_PDF_SECRET= \
      -e EXPLORER_INGEST_SECRET= \
      "$IMAGE"
  }

  # Returns 0 when /health is ok, 2 when the container was OOM-killed, 1 otherwise.
  wait_for_health() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
    local status body
    echo "== GET /health (timeout ${HEALTH_TIMEOUT_SECONDS}s) =="
    while ((SECONDS < deadline)); do
      status="$(docker inspect --format '{{.State.Status}} {{.State.OOMKilled}}' "$NAME" 2>/dev/null || echo 'missing false')"
      if [[ "$status" == *" true" ]]; then
        echo "container OOM-killed (${status})"
        return 2
      fi
      if [[ "$status" != "running false" ]]; then
        echo "ERROR: container is not running (${status})." >&2
        return 1
      fi
      if body="$(curl -fsS --max-time 5 "http://127.0.0.1:${SMOKE_PORT}/health" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]]; then
        echo "$body"
        return 0
      fi
      sleep 2
    done
    status="$(docker inspect --format '{{.State.Status}} {{.State.OOMKilled}}' "$NAME" 2>/dev/null || echo 'missing false')"
    if [[ "$status" == *" true" ]]; then
      echo "container OOM-killed (${status})"
      return 2
    fi
    echo "ERROR: /health did not return ok:true within ${HEALTH_TIMEOUT_SECONDS}s." >&2
    return 1
  }

  echo "== boot ${IMAGE} on ${NET} (dummy env, port ${SMOKE_PORT}) =="
  if ((${#mem_args[@]} > 0)); then
    run_container "${mem_args[@]}"
  else
    run_container
  fi

  local health_rc=0
  wait_for_health || health_rc=$?
  if [[ "$health_rc" -eq 2 && ${#mem_args[@]} -gt 0 ]]; then
    mem_note="384MB cap is not feasible (container OOM-killed); retried without a cap"
    echo "WARNING: ${mem_note}"
    run_container
    wait_for_health
  elif [[ "$health_rc" -ne 0 ]]; then
    exit 1
  fi

  report_memory "$mem_note"
  echo "boot smoke passed"
}

case "${1:-all}" in
  migrations) cmd_migrations ;;
  build) cmd_build ;;
  smoke) cmd_smoke ;;
  all) cmd_migrations; cmd_build; cmd_smoke ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac

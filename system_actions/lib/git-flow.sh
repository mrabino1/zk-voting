# NOT FOR PROFIT — civic public good, not a commercial product.
# Git workflow helpers for system_actions.sh (DealPunchList-shaped).
#
# Branch flow:
#   feature/*  →  test/unstable (integration)  →  master (release)
#   Option 2: branch from test/unstable
#   Option 3: merge feature/* into test/unstable
#   Option 4: merge test/unstable into master (run from test/unstable)

launch_test_system() {
  need git
  need npm

  info "Git: fetch + pull..."
  local remote
  remote="$(git_default_remote)"
  git fetch "$remote"
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$INTEGRATION_BRANCH")"
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git pull --no-rebase
  else
    git pull --no-rebase "$remote" "$branch" || {
      warn "pull failed (no upstream set; remote branch may not exist yet)"
    }
  fi

  if [[ "$branch" == "$RELEASE_BRANCH" ]]; then
    warn "you are on $RELEASE_BRANCH (production). Launch is the development path."
    if [[ -t 0 ]]; then
      confirm "Continue launching npm run dev from $RELEASE_BRANCH?" || {
        info "aborted"
        return 1
      }
    fi
  fi

  source_project_env
  install_deps

  # Bind to 0.0.0.0 so Tailscale/remote access works. ZK_VOTING_HOST only —
  # do not inherit HOST from .env (may be a public IP).
  export HOST="${ZK_VOTING_HOST:-0.0.0.0}"
  export PORT="${ZK_VOTING_PORT:-${PORT:-3000}}"

  ok "launching Node on $branch @ $(current_sha)  HOST=$HOST PORT=$PORT"
  info "JSON store: $STORE_FILE (no Postgres). L2 is separate: ./l2/bin/start-local.sh"
  exec npm run dev
}

create_feature_branch() {
  info "Create new feature branch from $INTEGRATION_BRANCH..."

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    err "not in a git repository"
    exit 1
  fi

  local current
  current="$(current_branch)"
  if [[ "$current" != "$INTEGRATION_BRANCH" ]]; then
    err "must be on $INTEGRATION_BRANCH to create a feature branch (current: $current)"
    info "run: git checkout $INTEGRATION_BRANCH"
    exit 1
  fi

  local feature_name=""
  if [[ -n "${1:-}" ]]; then
    feature_name=$(echo "$1" | tr -d ' ')
  fi
  if [[ -z "$feature_name" ]]; then
    if [[ ! -t 0 ]]; then
      err "no feature name provided (usage: ./system_actions.sh 2 my-feature)"
      exit 1
    fi
    echo
    printf "  Feature name (e.g. my-feature or feature/my-feature): "
    read -r feature_name
    feature_name=$(echo "$feature_name" | tr -d ' ')
  fi
  if [[ -z "$feature_name" ]]; then
    err "no name provided"
    exit 1
  fi

  local feature_branch
  if [[ "$feature_name" != feature/* ]]; then
    feature_branch="feature/$feature_name"
  else
    feature_branch="$feature_name"
  fi

  if git rev-parse --verify "$feature_branch" >/dev/null 2>&1; then
    err "branch '$feature_branch' already exists"
    exit 1
  fi

  git checkout -b "$feature_branch"
  echo
  ok "created and switched to $feature_branch"
  if [[ -t 0 ]]; then
    printf "  Push to remote? [y/N] "
    local push_choice
    read -r push_choice
    if [[ "$push_choice" == "y" || "$push_choice" == "Y" ]]; then
      local remote
      remote="$(git_default_remote)"
      git push -u "$remote" "$feature_branch" && ok "pushed to $remote/$feature_branch" \
        || warn "push failed (check remote)"
    fi
  fi
}

merge_feature_to_main() {
  info "Merge feature branch into $INTEGRATION_BRANCH..."

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    err "not in a git repository"
    exit 1
  fi

  local remote current feature_branch was_on_feature
  remote="$(git_default_remote)"
  current="$(current_branch)"

  if [[ "$current" == feature/* ]]; then
    feature_branch="$current"
    was_on_feature=1
    info "using current branch: $feature_branch"
  elif [[ "$current" == "$INTEGRATION_BRANCH" ]]; then
    was_on_feature=0
    local other_branches=()
    mapfile -t other_branches < <(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null \
      | grep -E '^feature/' || true)
    if [[ ${#other_branches[@]} -eq 0 ]]; then
      echo
      echo "  No local feature/* branches found."
      echo "  Create one from $INTEGRATION_BRANCH: ./system_actions.sh 2 my-feature"
      return 0
    fi
    echo
    echo "  Local feature branches:"
    local i
    for i in "${!other_branches[@]}"; do
      echo "    $((i + 1))) ${other_branches[$i]}"
    done
    echo
    printf "  Feature branch name or number: "
    read -r feature_branch
    if [[ -z "$feature_branch" ]]; then
      err "no branch name provided"
      exit 1
    fi
    if [[ "$feature_branch" =~ ^[0-9]+$ ]] && [[ "$feature_branch" -ge 1 ]] && [[ "$feature_branch" -le ${#other_branches[@]} ]]; then
      feature_branch="${other_branches[$((feature_branch - 1))]}"
    fi
    if ! git rev-parse --verify "$feature_branch" >/dev/null 2>&1; then
      err "branch '$feature_branch' does not exist locally"
      exit 1
    fi
  else
    err "must be on $INTEGRATION_BRANCH or a feature/* branch (current: $current)"
    exit 1
  fi

  if working_tree_dirty; then
    err "working tree is dirty — commit or stash before merging"
    git status --short
    exit 1
  fi

  if [[ "$was_on_feature" -eq 1 ]]; then
    info "pushing $feature_branch..."
    git push "$remote" "$feature_branch" || warn "could not push $feature_branch (may not exist on remote yet)"
    info "checking out $INTEGRATION_BRANCH..."
    git checkout "$INTEGRATION_BRANCH" || {
      err "failed to checkout $INTEGRATION_BRANCH"
      exit 1
    }
  fi

  info "pulling latest $INTEGRATION_BRANCH..."
  git pull --no-rebase "$remote" "$INTEGRATION_BRANCH" || warn "failed to pull $INTEGRATION_BRANCH"

  info "merging $feature_branch into $INTEGRATION_BRANCH..."
  git merge "$feature_branch" --no-edit || {
    err "merge failed. Resolve conflicts and run: git add . && git commit && git push $remote $INTEGRATION_BRANCH"
    exit 1
  }

  info "pushing $INTEGRATION_BRANCH..."
  git push "$remote" "$INTEGRATION_BRANCH" || {
    err "failed to push $INTEGRATION_BRANCH"
    exit 1
  }

  ok "merged $feature_branch into $INTEGRATION_BRANCH"

  if [[ -t 0 ]]; then
    echo
    printf "  Delete branch '%s'? [y/N] " "$feature_branch"
    local delete_choice
    read -r delete_choice
    if [[ "$delete_choice" == "y" || "$delete_choice" == "Y" ]]; then
      git branch -d "$feature_branch" 2>/dev/null || git branch -D "$feature_branch" 2>/dev/null || true
      info "deleted local branch $feature_branch"
      printf "  Delete remote branch %s? [y/N] " "$feature_branch"
      local delete_remote
      read -r delete_remote
      if [[ "$delete_remote" == "y" || "$delete_remote" == "Y" ]]; then
        git push "$remote" --delete "$feature_branch" \
          && info "deleted remote branch $feature_branch" \
          || warn "could not delete remote (may not exist)"
      fi
    fi
  fi

  echo
  ok "done. You are on $INTEGRATION_BRANCH."
}

merge_feature_to_test() {
  merge_feature_to_main
}

merge_to_release() {
  echo
  printf "  Type MERGE to confirm release push: "
  local confirm
  read -r confirm
  if [[ "$confirm" != "MERGE" ]]; then
    err "confirmation failed. Aborted."
    exit 1
  fi
  echo

  if working_tree_dirty; then
    err "working tree is dirty — commit or stash before merging to $RELEASE_BRANCH"
    git status --short
    exit 1
  fi

  cmd_connectivity || true

  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    err "not in a git repository"
    exit 1
  fi

  local remote current
  remote="$(git_default_remote)"
  info "using remote: $remote"

  current="$(current_branch)"
  if [[ "$current" != "$INTEGRATION_BRANCH" ]]; then
    err "must be on $INTEGRATION_BRANCH to merge into $RELEASE_BRANCH (current: $current)"
    info "run: git checkout $INTEGRATION_BRANCH"
    exit 1
  fi

  if [[ "$INTEGRATION_BRANCH" == "$RELEASE_BRANCH" ]]; then
    info "syncing and pushing $RELEASE_BRANCH..."
    git push "$remote" "$RELEASE_BRANCH" || {
      err "failed to push $RELEASE_BRANCH"
      exit 1
    }
    git pull --no-rebase "$remote" "$RELEASE_BRANCH" || warn "pull had issues (continuing)"
    git push "$remote" "$RELEASE_BRANCH" || {
      err "failed to push $RELEASE_BRANCH"
      exit 1
    }
    ok "$RELEASE_BRANCH is up to date on $remote"
  else
    info "pushing $INTEGRATION_BRANCH..."
    git push "$remote" "$INTEGRATION_BRANCH" || exit 1
    git pull --no-rebase "$remote" "$INTEGRATION_BRANCH" || true
    git checkout "$RELEASE_BRANCH" || exit 1
    git pull --no-rebase "$remote" "$RELEASE_BRANCH" || true
    info "merging $INTEGRATION_BRANCH into $RELEASE_BRANCH..."
    git merge "$INTEGRATION_BRANCH" --no-edit || exit 1
    git push "$remote" "$RELEASE_BRANCH" || exit 1
    git checkout "$INTEGRATION_BRANCH" || true
    ok "merged $INTEGRATION_BRANCH into $RELEASE_BRANCH"
  fi

  echo
  info "code is on $RELEASE_BRANCH. Host restart is separate: ./system_actions.sh deploy-prod"
}

merge_to_master() {
  merge_to_release
}

#!/usr/bin/env bash
# Checks (or with --fix, rewrites) the ?v=<hash> cache-busting versions on
# local assets referenced from the site's HTML pages. Each version is the first
# 10 hex chars of the asset's sha256, so it changes whenever the file changes.
# Usage: site/check-assets.sh [--fix]
set -euo pipefail
cd "$(dirname "$0")/public"
fix=0; [[ "${1:-}" == "--fix" ]] && fix=1
status=0
for page in *.html; do
  for asset in $(grep -oE '(href|src)="[a-zA-Z0-9_./-]+\.(css|svg|png|jpg|webp|ico|js)(\?v=[a-f0-9]*)?"' "$page" | sed -E 's/^(href|src)="//; s/\?v=.*//; s/"$//' | sort -u); do
    [[ -f "$asset" ]] || { echo "missing asset: $asset (in $page)"; status=1; continue; }
    want=$(sha256sum "$asset" | cut -c1-10)
    if [[ $fix -eq 1 ]]; then
      sed -i -E "s#(href|src)=\"${asset//./\\.}(\?v=[a-f0-9]*)?\"#\1=\"${asset}?v=${want}\"#g" "$page"
    elif ! grep -q "=\"${asset}?v=${want}\"" "$page"; then
      echo "stale or missing ?v= for $asset in $page (want v=$want); run site/check-assets.sh --fix"; status=1
    fi
  done
done
[[ $status -eq 0 && $fix -eq 0 ]] && echo "asset versions OK"
exit $status

#!/usr/bin/env bash
# Kept so `./script/get-gas-economics.sh` still works from smart-contracts/.
# The script lives at the repository root: ../scripts/get-gas-economics.sh
# (see ../scripts/README.md). Same flags and environment variables.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/get-gas-economics.sh" "$@"

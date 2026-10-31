#!/usr/bin/env bash
# Kept so `./script/get-gas-economics.sh` still works from smart-contracts/.
# The script lives in voting_node: ../voting_node/scripts/get-gas-economics.sh
# (see ../voting_node/scripts/README.md). Same flags and environment variables.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/voting_node/scripts/get-gas-economics.sh" "$@"

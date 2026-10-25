#!/usr/bin/env bash
# Thin wrapper. The gas-economics script lives with the Foundry package.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/../smart-contracts"
exec ./script/get-gas-economics.sh "$@"

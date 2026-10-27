#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
# Groth16 phase-2 helpers. Running this script is not a ceremony.
# Keys stay untrusted until a real public ceremony is attested elsewhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT/circuits/scripts/ceremony.mjs" "$@"

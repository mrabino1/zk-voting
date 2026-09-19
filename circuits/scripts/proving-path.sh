#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
# Wrapper: compile / untrusted setup / export / prove. See HASH_SCHEME.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT/circuits/scripts/proving-path.mjs" "$@"

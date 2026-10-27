#!/usr/bin/env bash
# NOT FOR PROFIT — civic public good, not a commercial product.
# Guided setup for the zk-voting demo app. Same as demo/setup.sh.
# Choosing "none" for the setup token leaves SETUP_TOKEN empty. The server
# then prints a one-time token at boot. /setup asks for it. It is not written
# to .env and it is not served over HTTP.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/demo/setup.sh" "$@"

#!/bin/sh
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# A fresh Docker volume is owned by root. The sequencer and the Node both
# refuse to start when they cannot create files under the data directory,
# and Compose then reports the container unhealthy. This script gives that
# one directory to the node user and drops root before the real command.
# Do not set USER node in the image: this script would then be unable to chown.

set -eu

data_dir="${DATA_DIR:-${L2_DATA_DIR:-/data}}"

if [ "$(id -u)" = "0" ]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "zk-voting: setpriv is required to drop root" >&2
    exit 1
  fi
  mkdir -p "$data_dir"
  if ! setpriv --reuid=node --regid=node --init-groups -- /usr/bin/test -w "$data_dir"; then
    chown node:node "$data_dir"
    echo "zk-voting: gave $data_dir to the node user" >&2
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"

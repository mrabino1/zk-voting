#!/bin/sh
# NOT FOR PROFIT — civic public good, not a commercial product.
#
# A fresh Docker volume is owned by root. The sequencer and the Node both
# refuse to start when they cannot create files under the data directory,
# and Compose then reports the container unhealthy. This script gives that
# directory (and INSTALL_DIR, the settings volume /setup shares between the
# node and l2, when set) to the node user and drops root before the real command.
# Do not set USER node in the image: this script would then be unable to chown.

set -eu

data_dir="${DATA_DIR:-${L2_DATA_DIR:-/data}}"

if [ "$(id -u)" = "0" ]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "zk-voting: setpriv is required to drop root" >&2
    exit 1
  fi
  for dir in "$data_dir" ${INSTALL_DIR:+"$INSTALL_DIR"}; do
    mkdir -p "$dir"
    if ! setpriv --reuid=node --regid=node --init-groups -- /usr/bin/test -w "$dir"; then
      chown node:node "$dir"
      echo "zk-voting: gave $dir to the node user" >&2
    fi
  done
  # Settings written by /setup hold keys: keep the directory private to the node user.
  if [ -n "${INSTALL_DIR:-}" ]; then chmod 700 "$INSTALL_DIR"; fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"

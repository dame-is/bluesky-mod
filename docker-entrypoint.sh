#!/bin/sh
# Render, Railway and Fly mount the data disk owned by root, where the node
# user cannot write. Started as root, this hands the data directory to node
# and drops to it before anything runs; started as any other user, it runs
# the command as it is.
set -e
if [ "$(id -u)" = "0" ]; then
  dir="${DATA_DIR:-/app/data}"
  mkdir -p "$dir"
  chown -R node:node "$dir"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"

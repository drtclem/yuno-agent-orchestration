#!/bin/sh
set -eu
printf 'Delete all Yuno data and runtime sessions? Type yes to continue: '
read -r answer || exit 0
[ "$answer" = yes ] || exit 0
if [ -L data ]; then
  echo 'Refusing to reset: data is a symlink.' >&2
  exit 1
fi
docker compose down
# Container-created directories can be root-owned on Linux; unlink their contents as root.
docker compose run --rm --no-deps --entrypoint node app -e 'const fs = require("node:fs"); for (const name of fs.readdirSync("/data")) fs.rmSync("/data/" + name, { recursive: true, force: true });'
docker compose down --volumes
rm -rf ./data

#!/usr/bin/env sh
# Run a Fount multiplayer server.
#
#   ./serve.sh                          port 8099, all interfaces
#   ./serve.sh --port 8080
#   ./serve.sh --name "My Server" --map game/maps/test_playground.json
#
# The server hosts the game files AND the multiplayer session on one port, so
# anyone who can reach that port can play — no separate web server needed.
# Node 18+ only; there are no npm dependencies to install.

set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required to run a server." >&2
  echo "Install it from https://nodejs.org/ and run this again." >&2
  echo "(Single-player needs no Node at all — use ./run.sh instead.)" >&2
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $MAJOR is too old; this server needs Node 18 or newer." >&2
  exit 1
fi

if [ "${1:-}" = "--online" ]; then
  shift
  exec node --no-warnings "$DIR/server/mmo.mjs" "$@"
fi

exec node "$DIR/server/server.mjs" "$@"

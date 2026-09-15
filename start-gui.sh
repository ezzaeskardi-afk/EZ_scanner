#!/usr/bin/env bash
# EZ Scanner launcher — Linux / macOS / Termux
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js (22.18 or newer) is required: https://nodejs.org" >&2
  exit 1
fi

node_major=$(node -p "process.versions.node.split('.')[0]")
node_minor=$(node -p "process.versions.node.split('.')[1]")
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then
  echo "Node.js 22.18+ is required (found $(node -v))." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one time)…"
  npm install --no-audit --no-fund
fi

exec node src/cli/main.ts gui "$@"

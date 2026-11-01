#!/bin/sh
set -eu
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required. Install it from https://bun.sh then run this installer again." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the installer." >&2
  exit 1
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/dinobot-install.XXXXXXXX")
trap 'rm -rf "$tmp"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
status=$(curl --proto '=https' --max-redirs 0 --connect-timeout 15 --max-time 120 --fail --silent --show-error --output "$tmp/install.mjs" --write-out '%{http_code}' https://releases.dinobot.workers.dev/install.mjs)
if [ "$status" != 200 ]; then
  echo "Installer download rejected (HTTP $status)." >&2
  exit 1
fi
bun "$tmp/install.mjs" --install

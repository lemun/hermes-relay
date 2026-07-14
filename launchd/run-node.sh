#!/bin/sh
# launchd wrapper: resolve node via nvm at RUN time instead of baking a
# version-pinned nvm path into the plists (a PATH pinned to one node version
# breaks silently on every `nvm install` — build mandate, 2026-07-06).
#
# Usage (from a plist): run-node.sh /path/to/script.mjs [args...]

umask 077

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm.sh sets PATH to the default alias's bin dir. --no-use would skip that,
# so source it plainly; if nvm is missing we fall through to system node.
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi

# Homebrew + local bins: gh, ffmpeg, whisper-cli, caffeinate helpers live here.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export PATH

exec node "$@"

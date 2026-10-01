#!/usr/bin/env bash
# Sign the extension for Firefox (AMO "unlisted" channel) -> dist/*.xpi.
# Credentials come from ~/.config/send-to-orca/amo.env (chmod 600):
#   WEB_EXT_API_KEY=user:12345:67
#   WEB_EXT_API_SECRET=...
# Bump "version" in extension/manifest.json first; AMO rejects reused versions.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="$HOME/.config/send-to-orca/amo.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see header of this script)" >&2; exit 1; }
[ "$(stat -c %a "$ENV_FILE")" = "600" ] || { echo "chmod 600 $ENV_FILE first" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
exec npx --yes web-ext sign -s extension -a dist --channel=unlisted

#!/usr/bin/env bash
# Install the orca_bridge helper for the current Linux user:
# ~/.local/bin/orca_bridge + a systemd user service started at login.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$BIN_DIR" "$UNIT_DIR" "$HOME/.config/orca-bridge"
cp "$HERE/orca_bridge.py" "$BIN_DIR/orca_bridge.py"

if command -v systemctl >/dev/null 2>&1; then
  cat >"$UNIT_DIR/orca-bridge.service" <<EOF
[Unit]
Description=Orca Bridge - opens STEP files from the Onshape extension in the local slicer

[Service]
ExecStart=$BIN_DIR/orca_bridge.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now orca-bridge.service
  sleep 1
  curl -sf http://127.0.0.1:17890/health && echo && \
    echo "Installed and running. Slicer auto-detected (see /health)."
else
  echo "systemd not available — start the helper manually:"
  echo "  $BIN_DIR/orca_bridge.py"
fi

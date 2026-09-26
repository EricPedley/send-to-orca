#!/usr/bin/env bash
# Self-test for orca_bridge.py: starts the daemon with a stub "slicer", runs a
# preflight + POST through it, and asserts the stub received the file.
# Also checks AppImage discovery with a fake HOME. No slicer needed.
# Run: bridge/test_orca_bridge.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=17991

STUB_LOG="$(mktemp)"
STUB_CMD="$(mktemp)"
cat >"$STUB_CMD" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$STUB_LOG"
EOF
chmod +x "$STUB_CMD"

# minimal STEP-looking payload (the daemon validates the ISO-10303-21 magic)
STEP="$(mktemp)"
printf 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nEND-ISO-10303-21;\n' >"$STEP"

ORCA_BRIDGE_CMD="$STUB_CMD" python3 "$HERE/orca_bridge.py" --port "$PORT" &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null || true; rm -f "$STUB_LOG" "$STUB_CMD" "$STEP"' EXIT
sleep 0.8

fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. health
curl -sf "http://127.0.0.1:$PORT/health" | grep -q '"ok":true' || fail health

# 2. PNA/CORS preflight from the Onshape origin -> 204 + Private-Network ok
HDRS=$(curl -s -D - -o /dev/null -X OPTIONS "http://127.0.0.1:$PORT/send" \
  -H "Origin: https://cad.onshape.com" \
  -H "Access-Control-Request-Method: POST")
grep -qi "^HTTP.* 204" <<<"$HDRS" || fail "preflight status"
grep -qi "Access-Control-Allow-Private-Network: true" <<<"$HDRS" || fail "PNA header"

# 3. disallowed origin rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "http://127.0.0.1:$PORT/send" \
  -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST")
[ "$CODE" = 403 ] || fail "evil origin not rejected (got $CODE)"

# 4. non-STEP body rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" \
  --data-binary "hello")
[ "$CODE" = 400 ] || fail "non-STEP body not rejected (got $CODE)"

# 5. STEP relayed to the slicer command, byte-identical
RESP=$(curl -sf -X POST "http://127.0.0.1:$PORT/send" --data-binary @"$STEP")
grep -q '"ok":true' <<<"$RESP" || fail "send: $RESP"
RECV_FILE=$(sed -n 's/.*"file":"\([^"]*\)".*/\1/p' <<<"$RESP")
cmp -s "$STEP" "$RECV_FILE" || fail "relayed file content differs"

# 6. browser-extension origin accepted
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "http://127.0.0.1:$PORT/send" \
  -H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop" \
  -H "Access-Control-Request-Method: POST")
[ "$CODE" = 204 ] || fail "extension origin rejected (got $CODE)"

# 6b. configured slicer missing from PATH -> health ok:false, send 500 with error
ORCA_BRIDGE_CMD="no-such-slicer-xyz" python3 "$HERE/orca_bridge.py" --port $((PORT+1)) >/dev/null &
B2=$!
# 6c. slicer found but unexecutable (bad interpreter) -> send 500, not a dropped connection
BAD_CMD="$(mktemp)"
printf '#!/nonexistent/interpreter\n' >"$BAD_CMD"; chmod +x "$BAD_CMD"
ORCA_BRIDGE_CMD="$BAD_CMD" python3 "$HERE/orca_bridge.py" --port $((PORT+2)) >/dev/null &
B3=$!
sleep 0.8
curl -s "http://127.0.0.1:$((PORT+1))/health" | grep -q '"ok":false' || { kill $B2 $B3; fail "health ok with missing slicer"; }
R2=$(curl -s -w ' %{http_code}' -X POST "http://127.0.0.1:$((PORT+1))/send" --data-binary @"$STEP")
R3=$(curl -s -w ' %{http_code}' -X POST "http://127.0.0.1:$((PORT+2))/send" --data-binary @"$STEP")
kill $B2 $B3; rm -f "$BAD_CMD"
[[ "$R2" == *'"ok":false'*' 500' ]] || fail "missing slicer send: $R2"
[[ "$R3" == *'cannot start slicer'*' 500' ]] || fail "spawn failure send: $R3"

# 7. AppImage discovery in a known base dir (fake HOME)
FAKE_HOME=$(mktemp -d)
mkdir -p "$FAKE_HOME/Applications"
touch "$FAKE_HOME/Applications/OrcaSlicer-Linux_V2.3.4.AppImage"
chmod +x "$FAKE_HOME/Applications/OrcaSlicer-Linux_V2.3.4.AppImage"
FOUND=$(HOME="$FAKE_HOME" python3 "$HERE/orca_bridge.py" --check | grep -o "$FAKE_HOME/Applications[^\"]*")
echo "$FOUND" | grep -q "OrcaSlicer-Linux_V2.3.4.AppImage" || fail "appimage in known base (got: $FOUND)"

# 7b. deep sweep of \$HOME when no known base matches
rm "$FAKE_HOME/Applications/OrcaSlicer-Linux_V2.3.4.AppImage"
mkdir -p "$FAKE_HOME/appimage/nested"
touch "$FAKE_HOME/appimage/nested/OrcaSlicer_nightly_belt.AppImage"
chmod +x "$FAKE_HOME/appimage/nested/OrcaSlicer_nightly_belt.AppImage"
FOUND2=$(HOME="$FAKE_HOME" python3 "$HERE/orca_bridge.py" --check)
rm -rf "$FAKE_HOME"
echo "$FOUND2" | grep -q "appimage/nested/OrcaSlicer_nightly_belt.AppImage" || fail "deep appimage sweep (got: $FOUND2)"

echo "PASS — all checks (stub slicer received $(wc -c <"$RECV_FILE") bytes)"

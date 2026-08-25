#!/usr/bin/env python3
"""orca_bridge — localhost receiver that opens a STEP file in the local OrcaSlicer.

The Onshape agent-app panel exports the STEP server-side, then the browser
relays the bytes here (POST http://127.0.0.1:17890/send). This daemon writes
the file to /tmp and spawns the local slicer binary with it — it lands on the
Prepare tab with zero user interaction.

Runs on the CLIENT machine where the browser (and the slicer) live. Binds to
loopback only: reachable by this machine's browser and local processes, by
nothing else. Start it from the desktop session so spawned children inherit
DISPLAY/WAYLAND_DISPLAY/XAUTHORITY — see orca_bridge.desktop autostart entry.

Slicer resolution order:
  1. ORCA_BRIDGE_CMD env ("orca-belt" | "/path/to/orca-slicer" | full cmdline)
  2. ~/.config/orca-bridge/config.json {"command": "..."}
  3. first of orca-belt / orca-slicer / orcaslicer found in $PATH

Usage: python3 orca_bridge.py [--check] [--port N]
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_PORT = 17890
MAX_BODY = 512 * 1024 * 1024

# Origins allowed to relay into this daemon.
# a sandboxed iframe reports Origin: "null"; the send-to-orca BROWSER EXTENSION
# sends its chrome-extension:// id.
# ponytail: accepting "null"/any extension lets a hostile page open Orca with
# junk content; listener is loopback-only so blast radius is one wasted window.
# The extension's content scripts run with the page origin (cad.onshape.com);
# a sandboxed iframe reports Origin: "null"; unpacked extensions report their
# chrome-extension:// id. Loopback bind keeps everything else out anyway.
ALLOWED_ORIGINS = {
    "https://cad.onshape.com",
    "null",
}


def _origin_ok(origin: str) -> bool:
    return (not origin or origin in ALLOWED_ORIGINS
            or origin.startswith("chrome-extension://"))
# Binary names seen in the wild: upstream deb/appimage -> orca-slicer,
# Arch/AUR -> orcaslicer, local forks (belt builds) -> orca-belt*.
ORCA_NAMES = ["orca-belt", "orca-slicer", "orcaslicer", "OrcaSlicer"]
FLATPAK_APP_ID = "com.softfever3d.OrcaSlicer"


def _find_flatpak() -> str | None:
    """Return the app id of an installed OrcaSlicer flatpak, if any."""
    fp = shutil.which("flatpak")
    if not fp:
        return None
    try:
        out = subprocess.run(
            [fp, "list", "--app", "--columns=application"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if "orca" in line.lower():
            return line.strip()
    return None


_APPIMAGE_SCANNED = False
_APPIMAGE_HIT: Path | None = None


def _scan_appimages() -> Path | None:
    """Known bases first, then one bounded sweep of $HOME (depth <= 4).
    People drop AppImages anywhere; the sweep finds them without sudo."""
    home = Path.home()
    for base in [home / "Applications", home / ".local/bin", home / "bin",
                 home / "Apps", home / "appimage", home / "Downloads", Path("/opt")]:
        try:
            if base.is_dir():
                for p in sorted(base.iterdir()):
                    if p.suffix.lower() == ".appimage" and "orca" in p.name.lower():
                        return p
        except OSError:
            continue
    best: Path | None = None
    try:
        for dirpath, dirnames, filenames in os.walk(home):
            rel = os.path.relpath(dirpath, home)
            depth = 0 if rel == "." else rel.count(os.sep) + 1
            if depth >= 4:
                dirnames[:] = []
            dirnames[:] = [d for d in dirnames
                           if not d.startswith((".", "_"))
                           and d not in ("snap", "node_modules")]
            for f in filenames:
                if f.lower().endswith(".appimage") and "orca" in f.lower():
                    return Path(dirpath) / f
    except OSError:
        pass
    return best


def _find_appimage() -> Path | None:
    global _APPIMAGE_SCANNED, _APPIMAGE_HIT
    if not _APPIMAGE_SCANNED:
        _APPIMAGE_SCANNED = True
        _APPIMAGE_HIT = _scan_appimages()
    return _APPIMAGE_HIT


def resolve_cmd() -> list[str] | None:
    """Locate a usable slicer launcher.

    Order: explicit config (env ORCA_BRIDGE_CMD or ~/.config/orca-bridge/
    config.json) > binaries in $PATH > AppImage in common folders > flatpak.
    Returns an argv list; None when nothing usable is installed.
    """
    cand = os.environ.get("ORCA_BRIDGE_CMD")
    if not cand:
        cfg = Path.home() / ".config/orca-bridge/config.json"
        if cfg.exists():
            try:
                cand = json.loads(cfg.read_text()).get("command")
            except Exception:
                cand = None
    if cand:
        parts = shlex.split(cand)
        parts[0] = shutil.which(parts[0]) or parts[0]
        return parts
    for name in ORCA_NAMES:
        p = shutil.which(name)
        if p:
            return [p]
    appimage = _find_appimage()
    if appimage:
        # FUSE-less environments need extraction; harmless otherwise.
        # ponytail: always-extract adds ~10s startup; switch if users complain.
        return [str(appimage)]
    app_id = _find_flatpak()
    if app_id:
        return ["flatpak", "run", FLATPAK_APP_ID if " " not in app_id else app_id]
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # visible in journalctl for diagnostics
        print(f"REQ {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code: int, payload: bytes, origin: str = "") -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):  # CORS + Chrome Private Network Access preflight
        origin = self.headers.get("Origin", "")
        if origin and not _origin_ok(origin):
            self._json(403, b'{"ok":false,"error":"origin not allowed"}')
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin", "")
        if origin and not _origin_ok(origin):
            self._json(403, b'{"ok":false,"error":"origin not allowed"}')
            return
        if self.path == "/health":
            cmd = resolve_cmd()
            self._json(200, json.dumps(
                {"ok": True, "slicer": cmd[0] if cmd else None},
                separators=(",", ":")).encode(), origin or "*")
        else:
            self._json(404, b'{"ok":false,"error":"not found"}', origin or "*")

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        if origin and not _origin_ok(origin):
            self._json(403, b'{"ok":false,"error":"origin not allowed"}')
            return
        allow = origin or "*"
        if self.path == "/dump":  # diagnostics channel: print payload to journal
            try:
                n = int(self.headers.get("Content-Length", 0))
            except ValueError:
                n = 0
            if 0 < n <= 4 * 1024 * 1024:
                print("DUMP " + self.rfile.read(n).decode("utf-8", "replace"), flush=True)
            self._json(200, b'{"ok":true}', allow)
            return
        if self.path != "/send":
            self._json(404, b'{"ok":false,"error":"not found"}', allow)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._json(400, b'{"ok":false,"error":"bad Content-Length"}', allow)
            return
        data = self.rfile.read(n)
        if b"ISO-10303-21" not in data[:1024]:
            self._json(400, b'{"ok":false,"error":"body is not a STEP file"}', allow)
            return
        cmd = resolve_cmd()
        if not cmd:
            self._json(500, b'{"ok":false,"error":"no slicer binary found in PATH '
                            b'(set ORCA_BRIDGE_CMD or ~/.config/orca-bridge/config.json)"}',
                       allow)
            return
        out = Path(tempfile.gettempdir()) / f"onshape_{time.strftime('%Y%m%d_%H%M%S')}.step"
        out.write_bytes(data)
        subprocess.Popen(cmd + [str(out)], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self._json(200, json.dumps({"ok": True, "file": str(out), "cmd": cmd[0]},
                                   separators=(",", ":")).encode(), allow)


def main() -> int:
    port = DEFAULT_PORT
    args = sys.argv[1:]
    if "--check" in args:
        cmd = resolve_cmd()
        print(json.dumps({"slicer": cmd[0] if cmd else None,
                          "cmdline": " ".join(cmd) if cmd else None}))
        return 0 if cmd else 1
    if "--port" in args:
        port = int(args[args.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"orca_bridge listening on 127.0.0.1:{port}, slicer: "
          f"{(resolve_cmd() or ['<none>'])[0]}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

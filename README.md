# Send to Orca Slicer — Onshape ➜ OrcaSlicer in one click

A browser extension plus a tiny local helper. Click the **🖨 Orca** pill while
viewing a Part Studio on [cad.onshape.com](https://cad.onshape.com) and your
model opens in OrcaSlicer **on your own computer**, ready on the Prepare tab.

- **No server, no cloud middleman, no API keys**
- Uses *your* logged-in Onshape session — same as clicking Onshape's own Export
- The helper listens on `127.0.0.1` only; nothing on your network can reach it
- If the helper isn't running, the extension falls back to a plain STEP download

```
Onshape tab (your session) ──STEP──► orca_bridge helper (127.0.0.1:17890)
        ▲                                      │ spawns
        └── you are already logged in ── OrcaSlicer → Prepare tab
```

## Install

### 1. Helper (spawns the slicer)

| platform | how |
|---|---|
| **Linux** | `bridge/install-linux.sh` — installs to `~/.local/bin` and registers a user service |
| **Windows** | install [Python 3](https://python.org), double-click `windows/orca-bridge.bat` (run at login for always-on) |
| **macOS** | double-click `macos/orca-bridge.command` (add to Login Items for always-on) |

The helper auto-detects your slicer: binaries named `orca-slicer` / `orcaslicer`
/ `orca-belt*` on `$PATH`, any `*.AppImage` with "orca" in its name in common
folders (`~/Applications`, `~/appimage`, `~/.local/bin`, `~/bin`, `~/Downloads`,
`/opt`) or anywhere under your home directory, then Flatpak
(`com.orcaslicer.OrcaSlicer`).

Pin a specific slicer explicitly:

```bash
mkdir -p ~/.config/orca-bridge
echo '{"command": "orca-slicer"}' > ~/.config/orca-bridge/config.json
```

### 2. Extension

Chrome / Edge / Brave:
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder

Firefox: load via `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on…** (per-session until signed).

### 3. Use it

Open a Part Studio → click the **🖨 Orca** pill (bottom-right) or press
**Alt+Shift+O**. A few seconds later OrcaSlicer opens with your model.

## How it works

1. The extension injects code into the Onshape page that calls Onshape's own
   internal API (`/api/v14/...`) **as first-party page code**, attaching your
   existing session cookies and CSRF token — exactly like Onshape's Export
   button does. It requests a STEP translation of the current element.
2. When the translation finishes, the STEP is downloaded through your session.
3. The bytes are POSTed to `http://127.0.0.1:17890/send`. The helper validates
   the file, writes it to a temp folder, and launches your slicer with it.
4. No dialog appears in OrcaSlicer: it lands directly on the Prepare tab.

> **Tip:** if you see Orca's "Step file import parameters" dialog every time,
> tick *Don't show again* once — future imports are silent.

## Privacy & security

- Your credentials never leave your browser; export traffic goes only between
  cad.onshape.com and your machine.
- The helper binds exclusively to loopback and refuses origins other than the
  Onshape page and your browser's extension origin.
- Worst case from a hostile local web page: it could open OrcaSlicer with junk
  content. It cannot read files, execute commands, or reach the network.

## Troubleshooting

| symptom | fix |
|---|---|
| pill says "downloaded (bridge off)" | helper not running — start it (step 1) |
| red error containing `HTTP 401` | log out/in of Onshape once, reload the tab |
| red error mentioning "no slicer binary" | none detected — set `config.json` (above) |
| Orca opens empty | check the helper log: `journalctl --user -u orca-bridge` (Linux) |

Self-test the helper without a slicer:

```bash
bridge/test_orca_bridge.sh
```

## Files

```
extension/            browser extension (MV3)
  manifest.json       host permissions: cad.onshape.com + loopback
  content.js          pill UI + relay to the helper + download fallback
  export-main.js      page-world exporter (session cookies + CSRF token)
bridge/
  orca_bridge.py      the local helper (Python 3 stdlib only)
  install-linux.sh    Linux installer (systemd user service)
  test_orca_bridge.sh self-test, no slicer required
  config.example.json optional explicit slicer pinning
windows/ macos/       double-click launchers
```

## Roadmap

- Signed packages: `.exe` installer (PyInstaller), `.dmg`, Web Store listing
- Optional slicing presets (printer/filament auto-selection)

## License

[MIT](LICENSE)

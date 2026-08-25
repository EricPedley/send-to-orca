// Send to Orca Slicer — content script (isolated world) for cad.onshape.com.
//
// Injects a floating "🖨 Orca" pill. The actual Onshape export runs in the
// PAGE world (export-main.js, see manifest) so it carries the user's session
// cookies; this script only renders the pill, relays STEP bytes to the local
// orca_bridge helper (http://127.0.0.1:17890), and falls back to a plain
// download when the helper is off. No API keys, no server.

(function () {
  const BRIDGE = "http://127.0.0.1:17890";

  // ---- UI ------------------------------------------------------------------
  const BTN_ID = "send-to-orca-pill";
  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    const b = document.createElement("button");
    b.id = BTN_ID;
    b.textContent = "\u{1F5A8} Orca";
    Object.assign(b.style, {
      position: "fixed", right: "18px", bottom: "64px", zIndex: 999999,
      padding: "8px 14px", borderRadius: "20px", border: "none",
      background: "#1f2937", color: "#fff", font: "600 13px system-ui, sans-serif",
      cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.35)", opacity: "0.92",
    });
    b.title = "Export current tab as STEP and open it in OrcaSlicer on this computer (Alt+Shift+O)";
    b.addEventListener("click", onClick);
    document.documentElement.appendChild(b);
  }
  setInterval(ensureButton, 2000);

  function setPill(text, bg) {
    const b = document.getElementById(BTN_ID);
    if (!b) return;
    b.textContent = text;
    b.style.background = bg || "#1f2937";
  }

  // keyboard accelerator — works even when the pill is off-screen.
  window.addEventListener("keydown", (e) => {
    const chord = e.altKey && e.shiftKey && e.code === "KeyO";
    const altChord = e.ctrlKey && e.altKey && e.code === "KeyO";
    if (chord || altChord) {
      e.preventDefault();
      e.stopPropagation();
      const b = document.getElementById(BTN_ID);
      if (b && !b.dataset.busy) onClick();
    }
  }, { capture: true });

  // ---- ask the page world for the STEP -------------------------------------
  function pageCall(requestEvent, resultEvent, timeoutMs) {
    return new Promise((resolve, reject) => {
      const onResult = (ev) => { cleanup(); resolve(ev.detail); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("page call timed out")); },
        timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener(resultEvent, onResult);
      }
      window.addEventListener(resultEvent, onResult);
      window.dispatchEvent(new CustomEvent(requestEvent));
    });
  }

  async function onClick() {
    const b = document.getElementById(BTN_ID);
    if (b && b.dataset.busy) return;
    if (b) b.dataset.busy = "1";
    try {
      setPill("\u23F3 exporting\u2026", "#2563eb");
      const res = await pageCall("orca-export-request", "orca-export-result", 200000);
      if (!res.ok) throw new Error(res.error);
      const blob = new Blob([res.data], { type: "application/step" });

      setPill("\u23F3 opening Orca\u2026", "#2563eb");
      try {
        const r2 = await fetch(BRIDGE + "/send",
          { method: "POST", headers: { "content-type": "application/step" }, body: blob });
        const j = await r2.json();
        if (!r2.ok || !j.ok) throw new Error(j.error || ("bridge HTTP " + r2.status));
        setPill("\u2705 opened in OrcaSlicer", "#15803d");
      } catch (bridgeErr) {
        // helper not running -> still give the user the file
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "onshape_" + new Date().toISOString().replace(/[:T]/g, "").slice(0, 15) + ".step";
        document.documentElement.appendChild(a); a.click(); a.remove();
        setPill("\u{1F4E5} downloaded (bridge off)", "#b45309");
        console.warn("[send-to-orca] bridge unreachable:", bridgeErr);
      }
    } catch (err) {
      console.error("[send-to-orca]", err);
      setPill("\u2715 " + String(err.message || err).slice(0, 60), "#b91c1c");
      // ship the captured SPA request headers to the bridge journal for analysis
      try {
        const dump = await pageCall("orca-dump-request", "orca-dump-result", 8000);
        await fetch(BRIDGE + "/dump", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ err: String(err.message || err).slice(0, 200),
                                 reqs: dump.reqs || [] }),
        });
      } catch (_) {}
    }
    setTimeout(() => {
      setPill("\u{1F5A8} Orca");
      const bb = document.getElementById(BTN_ID);
      if (bb) delete bb.dataset.busy;
    }, 5000);
  }
})();

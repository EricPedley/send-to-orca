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
  function pageCall(requestEvent, resultEvent, timeoutMs, request) {
    return new Promise((resolve, reject) => {
      // Result events are broadcast; concurrent calls must only accept their own.
      const id = Math.random().toString(36).slice(2);
      const onResult = (ev) => {
        const d = ev.detail;
        if (d && typeof d === "object" && d.id !== undefined && d.id !== id) return;
        cleanup(); resolve(d);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("page call timed out")); },
        timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener(resultEvent, onResult);
      }
      window.addEventListener(resultEvent, onResult);
      window.dispatchEvent(new CustomEvent(requestEvent,
        { detail: JSON.stringify(Object.assign({ id }, request)) }));
    });
  }

  // ---- part picker ---------------------------------------------------------
  // Resolves to an array of selected parts, "whole" (one combined STEP), or
  // null when cancelled.
  function pickParts(parts) {
    return new Promise((resolve) => {
      const panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "fixed", right: "18px", bottom: "108px", zIndex: 999999,
        width: "280px", maxHeight: "60vh", display: "flex", flexDirection: "column",
        background: "#111827", color: "#f9fafb", borderRadius: "10px",
        font: "13px system-ui, sans-serif", boxShadow: "0 4px 20px rgba(0,0,0,.5)",
      });
      const head = document.createElement("div");
      head.textContent = "Send parts to Orca (" + parts.length + ")";
      Object.assign(head.style, { padding: "10px 12px", fontWeight: "600" });
      const list = document.createElement("div");
      Object.assign(list.style, { overflowY: "auto", padding: "0 12px" });
      const boxes = parts.map((p) => {
        const row = document.createElement("label");
        Object.assign(row.style, { display: "flex", gap: "8px", padding: "3px 0", cursor: "pointer" });
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = true;
        const t = document.createElement("span");
        t.textContent = p.name;
        row.append(cb, t);
        list.appendChild(row);
        return cb;
      });
      const bar = document.createElement("div");
      Object.assign(bar.style, { display: "flex", gap: "6px", flexWrap: "wrap", padding: "10px 12px" });
      function btn(label, bg, fn) {
        const b = document.createElement("button");
        b.textContent = label;
        Object.assign(b.style, { border: "none", borderRadius: "6px", padding: "5px 10px",
          background: bg, color: "#fff", cursor: "pointer", font: "inherit" });
        b.addEventListener("click", fn);
        bar.appendChild(b);
      }
      const done = (v) => { panel.remove(); resolve(v); };
      btn("Send selected", "#15803d", () => {
        const sel = parts.filter((_, i) => boxes[i].checked);
        done(sel.length ? sel : null);
      });
      btn("All/none", "#374151", () => {
        const on = !boxes.every((c) => c.checked);
        boxes.forEach((c) => { c.checked = on; });
      });
      btn("As one part", "#374151", () => done("whole"));
      btn("Cancel", "#7f1d1d", () => done(null));
      panel.append(head, list, bar);
      document.documentElement.appendChild(panel);
    });
  }

  async function exportOne(partId) {
    const res = await pageCall("orca-export-request", "orca-export-result", 200000,
      partId ? { partId } : null);
    if (!res.ok) throw new Error(res.error);
    return new Blob([res.data], { type: "application/step" });
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.documentElement.appendChild(a); a.click(); a.remove();
  }

  // Export each part as its own STEP (3 translations in flight) and stage
  // them on the bridge; one /launch then opens them all in a single Orca.
  async function sendParts(parts) {
    const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const blobs = new Array(parts.length);
    let next = 0, finished = 0;
    async function worker() {
      while (next < parts.length) {
        const i = next++;
        blobs[i] = await exportOne(parts[i].partId);
        setPill("\u23F3 exporting " + (++finished) + "/" + parts.length + "\u2026", "#2563eb");
      }
    }
    setPill("\u23F3 exporting 0/" + parts.length + "\u2026", "#2563eb");
    await Promise.all([worker(), worker(), worker()]);

    setPill("\u23F3 opening Orca\u2026", "#2563eb");
    try {
      for (let i = 0; i < parts.length; i++) {
        const r = await fetch(BRIDGE + "/stage?batch=" + batch + "&name=" +
          encodeURIComponent(parts[i].name),
          { method: "POST", headers: { "content-type": "application/step" }, body: blobs[i] });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || ("bridge HTTP " + r.status));
      }
      const r = await fetch(BRIDGE + "/launch?batch=" + batch, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ("bridge HTTP " + r.status));
      setPill("\u2705 " + parts.length + " parts opened in Orca", "#15803d");
    } catch (bridgeErr) {
      parts.forEach((p, i) => download(blobs[i], p.name + ".step"));
      setPill("\u{1F4E5} downloaded (bridge off)", "#b45309");
      console.warn("[send-to-orca] bridge unreachable:", bridgeErr);
    }
  }

  async function sendWhole() {
    const blob = await exportOne("");
    setPill("\u23F3 opening Orca\u2026", "#2563eb");
    try {
      const r2 = await fetch(BRIDGE + "/send",
        { method: "POST", headers: { "content-type": "application/step" }, body: blob });
      const j = await r2.json();
      if (!r2.ok || !j.ok) throw new Error(j.error || ("bridge HTTP " + r2.status));
      setPill("\u2705 opened in OrcaSlicer", "#15803d");
    } catch (bridgeErr) {
      // helper not running -> still give the user the file
      download(blob, "onshape_" + new Date().toISOString().replace(/[:T]/g, "").slice(0, 15) + ".step");
      setPill("\u{1F4E5} downloaded (bridge off)", "#b45309");
      console.warn("[send-to-orca] bridge unreachable:", bridgeErr);
    }
  }

  async function onClick() {
    const b = document.getElementById(BTN_ID);
    if (b && b.dataset.busy) return;
    if (b) b.dataset.busy = "1";
    try {
      setPill("\u23F3 listing parts\u2026", "#2563eb");
      let parts = [];
      try {
        const lp = JSON.parse(await pageCall("orca-parts-request", "orca-parts-result", 30000));
        if (lp.ok) parts = lp.parts;
      } catch (e) { console.warn("[send-to-orca] part list failed, exporting whole tab", e); }

      let choice = "whole";
      if (parts.length > 1) {
        setPill("\u261D choose parts", "#2563eb");
        choice = await pickParts(parts);
      } else if (parts.length === 1) {
        choice = parts;
      }
      if (choice === null) {
        setPill("cancelled", "#4b5563");
      } else if (choice === "whole") {
        setPill("\u23F3 exporting\u2026", "#2563eb");
        await sendWhole();
      } else {
        await sendParts(choice);
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

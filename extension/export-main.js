// export-main.js — runs in the PAGE world (manifest "world": "MAIN").
// Fetches issued here are first-party page fetches, so the browser attaches
// Onshape's HttpOnly SameSite session cookies exactly like the web app's own
// Export button does. Listens for a request event from the isolated-world
// content script and answers with STEP bytes (structured-cloned ArrayBuffer).

(function () {
  if (window.__orcaExportInstalled) return;
  window.__orcaExportInstalled = true;

  const POLL_TIMEOUT_MS = 180000;
  const API = "/api/v14";

  // The web app authenticates with session cookies + X-XSRF-TOKEN header
  // (constant per session, attached to every SPA call). We harvest the token
  // from the SPA's own captured requests instead of guessing its source.
  function xsrfToken() {
    for (const r of window.__osReq || []) {
      for (const [k, v] of Object.entries(r.h || {})) {
        if (k.toLowerCase() === "x-xsrf-token") return v;
      }
    }
    const m = document.cookie.match(/(?:^|;\s*)(?:xsrf-token|xsrt|XSRF-TOKEN)=([^;]+)/i);
    return m ? m[1] : "";
  }

  function authHeaders(extra) {
    return Object.assign({
      "content-type": "application/json",
      "X-XSRF-TOKEN": xsrfToken(),
      Accept: "application/json, text/plain, */*",
    }, extra || {});
  }

  // ---- capture how the SPA authenticates its own /api calls ----------------
  // Temporary instrumentation: records URL/method/headers of page-origin API
  // calls so the isolated script can ship them to the bridge journal.
  window.__osReq = [];
  function pushReq(entry) {
    if (window.__osReq.length < 60) window.__osReq.push(entry);
  }
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/api/")) {
        const h = {};
        let src = (init && init.headers) || (input instanceof Request ? input.headers : null);
        if (src) new Headers(src).forEach((v, k) => { h[k] = v; });
        pushReq({ t: "f", m: (init && init.method) || (input && input.method) || "GET",
                  u: String(url).slice(0, 140), h });
      }
    } catch (e) {}
    return _fetch.apply(this, arguments);
  };
  const _open = XMLHttpRequest.prototype.open;
  const _setH = XMLHttpRequest.prototype.setRequestHeader;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__orcaM = m; this.__orcaU = u; this.__orcaH = {};
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__orcaU && String(this.__orcaU).includes("/api/")) this.__orcaH[k] = v;
    } catch (e) {}
    return _setH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (this.__orcaU && String(this.__orcaU).includes("/api/"))
        pushReq({ t: "x", m: this.__orcaM || "GET", u: String(this.__orcaU).slice(0, 140),
                  h: this.__orcaH || {} });
    } catch (e) {}
    return _send.apply(this, arguments);
  };

  function getContext() {
    const seg = location.pathname.split("/").filter(Boolean);
    const i = seg.indexOf("documents");
    if (i < 0) return null;
    const did = seg[i + 1] || "";
    let wid = "", eid = "";
    for (let k = i + 2; k < seg.length - 1; k++) {
      if ((seg[k] === "w" || seg[k] === "v") && /^[0-9a-f]{24}$/i.test(seg[k + 1])) {
        if (seg[k] === "w") wid = seg[k + 1];
      }
      if (seg[k] === "e" && /^[0-9a-f]{24}$/i.test(seg[k + 1])) eid = seg[k + 1];
    }
    return { documentId: did, workspaceId: wid, elementId: eid };
  }

  async function startTranslation(ctx, partId) {
    const body = {
      formatName: "STEP", storeInDocument: false,
      flattenAssemblies: true, triggerAutoDownload: false,
    };
    if (partId) body.partIds = partId;
    const url = `${API}/partstudios/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}/translations`;
    let r = await fetch(url, {
      method: "POST", credentials: "include", headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (r.status >= 400) { // maybe an assembly tab
      r = await fetch(
        `${API}/assemblies/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}/translations`,
        { method: "POST", credentials: "include", headers: authHeaders(),
          body: JSON.stringify(body) });
    }
    if (!r.ok) {
      let b = "";
      try { b = (await r.text()).replace(/\s+/g, " ").slice(0, 90); } catch {}
      throw new Error(`export HTTP ${r.status} ${b} token=${xsrfToken() ? "yes" : "MISSING"}`);
    }
    return (await r.json()).id;
  }

  async function pollTranslation(tid, ctx) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const j = await (await fetch(`${API}/translations/${tid}`, {
        credentials: "include", headers: authHeaders(),
      })).json();
      if (j.requestState === "DONE") {
        const ext = (j.resultExternalDataIds || [])[0];
        if (!ext && !j.resultUrl) throw new Error("translation finished but no result");
        return j.resultUrl || `${API}/documents/d/${ctx.documentId}/externaldata/${ext}`;
      }
      if (j.requestState === "FAILED" || j.requestState === "ABORTED")
        throw new Error("Onshape translation failed");
      await new Promise(res => setTimeout(res, 2000));
    }
    throw new Error("export timed out");
  }

  function requireContext() {
    const ctx = getContext();
    if (!ctx || !ctx.documentId || !ctx.workspaceId || !ctx.elementId)
      throw new Error("open a Part Studio tab first");
    return ctx;
  }

  // Parts of the current Part Studio: [{partId, name}]. Empty for assemblies.
  async function listParts() {
    const ctx = requireContext();
    const r = await fetch(
      `${API}/parts/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}`,
      { credentials: "include", headers: authHeaders() });
    if (!r.ok) throw new Error("part list HTTP " + r.status);
    return (await r.json()).map((p) => ({ partId: p.partId, name: p.name || p.partId }));
  }

  async function doExport(partId) {
    const ctx = requireContext();
    const tid = await startTranslation(ctx, partId);
    const url = await pollTranslation(tid, ctx);
    const res = await fetch(url, { credentials: "include", headers: authHeaders() });
    if (!res.ok) throw new Error("STEP download HTTP " + res.status);
    return await res.arrayBuffer();
  }

  // Event details cross the page/content-script boundary as JSON strings
  // (Firefox blocks object details from the isolated world).
  window.addEventListener("orca-parts-request", async () => {
    let ok = true, parts = [], error = null;
    try { parts = await listParts(); }
    catch (e) { ok = false; error = String(e && e.message || e); }
    window.dispatchEvent(new CustomEvent("orca-parts-result", {
      detail: JSON.stringify({ ok, parts, error }),
    }));
  });

  window.addEventListener("orca-export-request", async (ev) => {
    let ok = true, data = null, error = null;
    let partId = "", id = "";
    try {
      const req = JSON.parse(ev.detail || "{}");
      partId = req.partId || ""; id = req.id || "";
    } catch (e) {}
    try { data = await doExport(partId); }
    catch (e) { ok = false; error = String(e && e.message || e); }
    window.dispatchEvent(new CustomEvent("orca-export-result", {
      detail: { id, ok, data, error, reqs: window.__osReq.slice(0, 25) },
    }));
  });

  window.addEventListener("orca-dump-request", () => {
    window.dispatchEvent(new CustomEvent("orca-dump-result", {
      detail: { reqs: window.__osReq.slice(0, 25) },
    }));
  });
})();

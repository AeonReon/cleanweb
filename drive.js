// drive.js — Drive Mode for cleanweb.
//
// Self-contained module. Reads engine URL from localStorage ('cleanweb.drive').
// Talks to cleanweb-engine on the Mac mini for: live JPEG screencast,
// natural-language agent loop, raw navigate calls.
//
// Loaded after app.js. Wires up the #driveToggleBtn in the topbar and the
// .drive-overlay element it injects.

(function () {
  "use strict";

  const LS_KEY = "cleanweb.drive";
  const DEFAULT_CFG = {
    engineUrl: "https://cleanweb-engine.aiprofits.cc",
    autoStart: false
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { ...DEFAULT_CFG };
      return { ...DEFAULT_CFG, ...JSON.parse(raw) };
    } catch { return { ...DEFAULT_CFG }; }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
  }

  const cfg = loadCfg();
  const state = {
    sessionId: null,
    frameWs: null,
    eventWs: null,
    open: false,
    busy: false
  };

  // ---------- DOM injection ----------
  function injectOverlay() {
    if (document.getElementById("driveOverlay")) return;
    const tpl = document.createElement("div");
    tpl.innerHTML = `
      <div class="drive-overlay" id="driveOverlay" role="dialog" aria-label="Drive Mode">
        <div class="drive-shell">
          <header class="drive-head">
            <div class="brand">
              <span class="brand-mark small"></span>
              <span>Drive Mode</span>
              <span class="head-tag">— browses the web for you</span>
            </div>
            <span class="pill" id="drvStatus">idle</span>
            <div class="head-spacer"></div>
            <span class="now-doing drv-hidden" id="drvNowDoing"><span class="nd-spin"></span><span id="drvNowDoingText">—</span></span>
            <button id="drvVault" class="icon-help" title="Vault (logins)" aria-label="Vault">🔐</button>
            <button id="drvWatches" class="icon-help" title="Watches (URL monitors)" aria-label="Watches">👁</button>
            <button id="drvSkills" class="icon-help" title="Skills (scrapers)" aria-label="Skills">🛠</button>
            <button id="drvDiag" class="icon-help" title="Run diagnostics" aria-label="Run diagnostics">⚡</button>
            <button id="drvHelp" class="icon-help" title="How does this work?" aria-label="Help">?</button>
            <button id="drvStart" class="primary">▶ Start session</button>
            <button id="drvStop" class="danger drv-hidden">Stop</button>
            <button id="drvClose">Close</button>
          </header>

          <section class="drive-viewer">
            <div class="pane-label">
              <span class="dot blue"></span> Live browser
              <span class="pane-tag">— watch the agent click, type and scroll</span>
            </div>
            <div class="url-row">
              <input type="text" id="drvUrl" placeholder="Or paste a URL to go straight there…" />
              <button id="drvGo">Go</button>
            </div>
            <div class="frame-wrap" id="drvFrameWrap">
              <div class="placeholder" id="drvPlaceholder">
                <div class="ph-icon">
                  <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="14" rx="2"/>
                    <path d="M7 22h10"/><path d="M12 18v4"/>
                  </svg>
                </div>
                <p class="ph-title">Nothing's running yet.</p>
                <p class="ph-sub">Click <b>▶ Start session</b> in the header.<br/>A real Chrome opens on your Mac and you'll see it live here.</p>
              </div>
              <img class="frame drv-hidden" id="drvFrame" alt="live browser" />
              <canvas id="drvDrawCanvas" class="drv-hidden"></canvas>
              <div class="draw-hint drv-hidden" id="drvDrawHint">
                Draw mode — drag a box around anything you want explained
              </div>
            </div>
            <div class="viewer-tools">
              <button id="drvDrawToggle" class="ghost-btn" disabled title="Draw a box around something to ask about it">
                ✏️ Draw to ask
              </button>
            </div>
          </section>

          <aside class="drive-chat">
            <div class="pane-label">
              <span class="dot gold"></span> Chat with the agent
              <span class="pane-tag">— tell it what to do in plain English</span>
            </div>
            <div class="status-row" id="drvStatusRow">
              <span class="srow-item" title="Cleanweb engine on your Mac mini">
                <span class="srow-dot" id="drvEngineDot"></span>
                <span class="srow-label">Engine</span>
                <span class="srow-val" id="drvEngineStatus">checking…</span>
              </span>
              <span class="srow-sep">·</span>
              <span class="srow-item" title="Local LM Studio that picks the next action">
                <span class="srow-dot" id="drvLmDot"></span>
                <span class="srow-label">LM Studio</span>
                <span class="srow-val" id="drvLmStatus">—</span>
              </span>
              <button class="srow-cfg" id="drvCfgToggle" title="Engine settings">⚙</button>
            </div>
            <div class="cfg drv-hidden" id="drvCfg">
              <label>Engine URL <input type="text" id="drvEngineUrl" placeholder="https://cleanweb-engine.aiprofits.cc" /></label>
            </div>

            <div class="log" id="drvLog">
              <div class="welcome" id="drvWelcome">
                <h3>What is this?</h3>
                <p>A real Chrome on your Mac mini, driven by a local AI.
                Type what you want and watch it happen on the left.
                Nothing leaves your house.</p>

                <h4>Try one of these:</h4>
                <div class="examples">
                  <button class="ex" data-q="Open en.wikipedia.org/wiki/Bob_Ross and give me 3 cheerful facts about him">🎨 Bob Ross facts</button>
                  <button class="ex" data-q="Open en.wikipedia.org/wiki/Octopus and tell me 3 surprising things about octopuses">🐙 Octopus surprises</button>
                  <button class="ex" data-q="Open duckduckgo.com, search for 'best independent café Belfast', and list 3 names">☕ Belfast cafés</button>
                  <button class="ex" data-q="Open en.wikipedia.org/wiki/Aurora and give me a one-paragraph summary of the Northern Lights">🌌 Northern Lights</button>
                  <button class="ex" data-q="Open gutenberg.org/ebooks/author/3406 — the Howard Pyle author page — and list 5 of his book titles">📚 Howard Pyle books</button>
                  <button class="ex" data-q="Open archive.org/details/booksbylanguage_english and pick one delightful-sounding free book to recommend">✨ A free book to read</button>
                </div>

                <h4>How the loop works</h4>
                <ol class="how">
                  <li><b>You say</b> what you want (or tap an example).</li>
                  <li><b>It looks</b> at the current page — semantically, like a screen reader.</li>
                  <li><b>It acts</b> — clicks, types, scrolls, navigates.</li>
                  <li><b>Repeat</b> until it has the answer or hits 14 steps.</li>
                  <li>If it's stuck, it'll <b>ask you</b> in this chat. Reply and it carries on.</li>
                </ol>

                <p class="muted small">First time? Click ▶ Start session up top.</p>
              </div>
            </div>
            <div id="drvAskWrap"></div>
            <div class="input-row">
              <input type="text" id="drvMsg" placeholder="Start a session first, then tell me what to do…" disabled />
              <button id="drvSend" disabled>Send</button>
            </div>
          </aside>
        </div>
      </div>`;
    document.body.appendChild(tpl.firstElementChild);
  }

  function injectTopButton() {
    const topRight = document.querySelector(".top-right");
    if (!topRight || document.getElementById("driveToggleBtn")) return;
    const btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.id = "driveToggleBtn";
    btn.title = "Drive Mode";
    btn.setAttribute("aria-label", "Drive Mode");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="14" rx="2"/>
        <path d="M7 22h10"/><path d="M12 18v4"/>
        <circle cx="12" cy="11" r="2.5"/>
        <path d="m8 14 2-2"/><path d="m16 14-2-2"/>
      </svg>`;
    // Put before settings (the cog) so the order is AI → Drive → Settings.
    const settingsBtn = topRight.querySelector("#settingsBtn");
    if (settingsBtn) topRight.insertBefore(btn, settingsBtn);
    else topRight.appendChild(btn);
  }

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  function esc(s) { return (s ?? "").toString().replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
  function log(klass, html) {
    const log = $("drvLog");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "msg " + klass;
    div.innerHTML = html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function pill(text) { return `<span class="pill-action">${esc(text)}</span>`; }

  function setStatus(label, klass) {
    const el = $("drvStatus");
    if (!el) return;
    el.textContent = label;
    el.className = "pill" + (klass ? " " + klass : "");
  }

  function setDot(id, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "srow-dot " + (kind || "");
  }

  async function pingEngine() {
    const val = $("drvEngineStatus");
    if (!val) return false;
    setDot("drvEngineDot", "amber");
    val.textContent = "checking…";
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/health", { cache: "no-store" });
      if (!r.ok) throw new Error("status " + r.status);
      const j = await r.json();
      val.textContent = `ok · ${j.sessions}/${j.maxSessions}`;
      setDot("drvEngineDot", "green");
      pingLm(j.lmStudio?.url);
      return true;
    } catch (e) {
      val.textContent = "unreachable";
      setDot("drvEngineDot", "red");
      setDot("drvLmDot", "");
      $("drvLmStatus").textContent = "—";
      return false;
    }
  }

  async function pingLm(lmUrl) {
    const val = $("drvLmStatus");
    if (!val || !lmUrl) return;
    setDot("drvLmDot", "amber");
    val.textContent = "checking…";
    // Best-effort: hit LM Studio's /models endpoint. Browser CORS may block —
    // if so the engine /health already tells us the URL is configured, which
    // is enough to show "configured" rather than fail loudly.
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(lmUrl.replace(/\/$/, "") + "/models", { signal: ctrl.signal });
      if (!r.ok) throw new Error();
      const j = await r.json();
      const count = (j.data || []).length;
      val.textContent = count ? `${count} model${count === 1 ? "" : "s"}` : "ready";
      setDot("drvLmDot", "green");
    } catch {
      val.textContent = "configured";
      setDot("drvLmDot", "amber");
    }
  }

  function hideWelcome() {
    const w = document.getElementById("drvWelcome");
    if (w) w.remove();
  }

  // ===== Draw-to-ask =====
  //
  // Overlay a canvas on top of the live frame. User drags a rectangle. We
  // translate the rectangle from display pixels (the canvas the user sees)
  // into viewport pixels (1280x800 by default — the Playwright context size)
  // and POST to /api/session/:id/ask-region. The model's answer drops into
  // the chat log.

  const VIEWPORT_W = 1280;
  const VIEWPORT_H = 800;
  let drawing = false;
  let drawStart = null;
  let drawMode = false;

  function setDrawMode(on) {
    drawMode = !!on;
    const c = document.getElementById("drvDrawCanvas");
    const hint = document.getElementById("drvDrawHint");
    const btn = document.getElementById("drvDrawToggle");
    if (drawMode) {
      c.classList.remove("drv-hidden");
      hint.classList.remove("drv-hidden");
      btn.classList.add("active");
      sizeCanvasToFrame();
    } else {
      c.classList.add("drv-hidden");
      hint.classList.add("drv-hidden");
      btn.classList.remove("active");
      clearCanvas();
    }
  }

  function sizeCanvasToFrame() {
    const c = document.getElementById("drvDrawCanvas");
    const frame = document.getElementById("drvFrame");
    if (!c || !frame) return;
    const r = frame.getBoundingClientRect();
    c.width = r.width;
    c.height = r.height;
    c.style.width = r.width + "px";
    c.style.height = r.height + "px";
    c.style.left = (frame.offsetLeft) + "px";
    c.style.top = (frame.offsetTop) + "px";
  }

  function clearCanvas() {
    const c = document.getElementById("drvDrawCanvas");
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
  }

  function drawRect(x1, y1, x2, y2) {
    const c = document.getElementById("drvDrawCanvas");
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#D4A44C";
    ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(212, 164, 76, 0.18)";
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  function onDrawMouseDown(e) {
    if (!drawMode) return;
    const c = document.getElementById("drvDrawCanvas");
    const r = c.getBoundingClientRect();
    drawing = true;
    drawStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onDrawMouseMove(e) {
    if (!drawing) return;
    const c = document.getElementById("drvDrawCanvas");
    const r = c.getBoundingClientRect();
    drawRect(drawStart.x, drawStart.y, e.clientX - r.left, e.clientY - r.top);
  }
  async function onDrawMouseUp(e) {
    if (!drawing) return;
    drawing = false;
    const c = document.getElementById("drvDrawCanvas");
    const r = c.getBoundingClientRect();
    const end = { x: e.clientX - r.left, y: e.clientY - r.top };
    const x1 = Math.min(drawStart.x, end.x);
    const y1 = Math.min(drawStart.y, end.y);
    const w = Math.abs(end.x - drawStart.x);
    const h = Math.abs(end.y - drawStart.y);
    if (w < 6 || h < 6) { clearCanvas(); return; }

    // Translate display pixels → viewport pixels.
    const scaleX = VIEWPORT_W / c.width;
    const scaleY = VIEWPORT_H / c.height;
    const bbox = {
      x: Math.round(x1 * scaleX),
      y: Math.round(y1 * scaleY),
      width: Math.round(w * scaleX),
      height: Math.round(h * scaleY)
    };

    const question = prompt("Ask about this area (or press OK for a general explanation):", "");
    setDrawMode(false);
    if (question === null) return; // cancelled
    hideWelcome();
    log("user", "✏️ <i>drew a box, asking:</i> " + esc(question || "explain this"));
    setNowDoing("Reading that region…");
    try {
      const r2 = await fetch(cfg.engineUrl.replace(/\/$/, "") + `/api/session/${state.sessionId}/ask-region`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, question })
      });
      const j = await r2.json();
      if (j.error) {
        log("error", "ask-region: " + esc(j.error));
      } else {
        log("agent", "<b>📍 Region answer.</b> " + esc(j.answer));
      }
    } catch (e) {
      log("error", "ask-region: " + esc(e.message));
    } finally {
      setNowDoing("");
    }
  }

  // ===== Vault panel =====
  async function showVault() {
    if (document.getElementById("drvVaultOverlay")) return;
    const div = document.createElement("div");
    div.id = "drvVaultOverlay";
    div.className = "help-overlay";
    div.innerHTML = `
      <div class="help-card" style="max-width:560px;">
        <button class="help-close" id="drvVaultClose" aria-label="Close">×</button>
        <h2>Vault <span class="muted small">(logins + cookies)</span></h2>
        <p class="muted small">PIN-encrypted on disk. Stays unlocked while the engine runs. Used by social-media Skills (Facebook, Instagram, X) so they can scrape logged-in views without you handing your password to a script.</p>
        <div id="drvVaultBody"><p>checking…</p></div>
      </div>`;
    document.body.appendChild(div);
    document.getElementById("drvVaultClose").onclick = () => div.remove();
    div.addEventListener("click", (e) => { if (e.target === div) div.remove(); });

    await renderVaultBody();
  }

  async function renderVaultBody() {
    const body = document.getElementById("drvVaultBody");
    if (!body) return;
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/status");
      const j = await r.json();
      if (!j.unlocked) {
        body.innerHTML = `
          <div class="vault-block">
            <p>${j.exists ? "Vault is locked. Enter your PIN to unlock." : "No vault yet. Pick a PIN (4+ characters) to create one."}</p>
            <div class="row">
              <input type="password" id="vPin" placeholder="PIN" autocomplete="off"/>
              <button id="vUnlock" class="primary">${j.exists ? "Unlock" : "Create"}</button>
            </div>
            <span id="vMsg" class="muted small"></span>
          </div>`;
        document.getElementById("vUnlock").onclick = unlockVault;
        document.getElementById("vPin").addEventListener("keydown", (e) => { if (e.key === "Enter") unlockVault(); });
        document.getElementById("vPin").focus();
        return;
      }
      // Unlocked — show entries + add form + cookie capture.
      const er = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/entries");
      const ej = await er.json();
      body.innerHTML = `
        <div class="vault-block">
          <div class="vault-head">
            <span class="srow-dot green"></span>
            <b>Unlocked</b>
            <span class="muted small">${ej.entries.length} entries</span>
            <button id="vLock" class="ghost-mini" style="margin-left:auto;">Lock</button>
          </div>
          <div id="vEntries">${
            ej.entries.length === 0
              ? `<p class="muted small">No entries yet. Add one below, or use "Save cookies from session".</p>`
              : ej.entries.map(e => `
                <div class="vault-entry" data-domain="${esc(e.domain)}">
                  <div>
                    <b>${esc(e.domain)}</b>
                    ${e.username ? ' <span class="muted small">' + esc(e.username) + '</span>' : ''}
                    <br/><small class="muted">${e.cookieCount} cookie${e.cookieCount === 1 ? "" : "s"} ${e.lastUsed ? "· used " + esc(relTime(e.lastUsed)) : ""}</small>
                  </div>
                  <button class="ghost-mini delete-entry" data-domain="${esc(e.domain)}">Delete</button>
                </div>`).join("")
          }</div>

          <details style="margin-top:14px;">
            <summary><b>+ Add a manual entry</b></summary>
            <div class="vault-form">
              <label>Domain <input type="text" id="vDomain" placeholder="facebook.com"/></label>
              <label>Username <input type="text" id="vUser" placeholder="(optional, for your reference)"/></label>
              <label>Password <input type="password" id="vPass" placeholder="(stored encrypted)"/></label>
              <label>Notes <input type="text" id="vNotes" placeholder="(optional)"/></label>
              <button id="vAdd" class="primary">Save</button>
            </div>
          </details>

          <details style="margin-top:10px;">
            <summary><b>📥 Save cookies from current session</b></summary>
            <p class="muted small" style="margin:8px 0;">Use this after you've logged into a site inside Drive Mode. Cookies for the given domain get stored so Skills can re-use the logged-in state later.</p>
            <div class="vault-form">
              <label>Domain to capture <input type="text" id="vCapDomain" placeholder="facebook.com"/></label>
              <button id="vCapture" class="primary" ${state.sessionId ? "" : "disabled"}>
                ${state.sessionId ? "Capture from session " + state.sessionId : "(start a session first)"}
              </button>
              <span id="vCapMsg" class="muted small"></span>
            </div>
          </details>
        </div>`;
      document.getElementById("vLock").onclick = lockVault;
      document.getElementById("vAdd").onclick = addEntry;
      document.getElementById("vCapture").onclick = captureCookies;
      document.querySelectorAll(".delete-entry").forEach(b => {
        b.onclick = async () => {
          if (!confirm("Delete vault entry for " + b.getAttribute("data-domain") + "?")) return;
          await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/entries/" + encodeURIComponent(b.getAttribute("data-domain")), { method: "DELETE" });
          renderVaultBody();
        };
      });
    } catch (e) {
      body.innerHTML = `<div class="diag-banner fail">Couldn't reach engine: ${esc(e.message)}</div>`;
    }

    function relTime(iso) {
      const ms = Date.now() - new Date(iso).getTime();
      if (ms < 60000) return "just now";
      if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
      if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
      return Math.round(ms / 86400000) + "d ago";
    }
  }

  async function unlockVault() {
    const pin = document.getElementById("vPin").value;
    const msg = document.getElementById("vMsg");
    msg.textContent = "unlocking…";
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const j = await r.json();
      if (j.ok) {
        renderVaultBody();
      } else {
        msg.textContent = "✕ " + (j.error || "failed");
      }
    } catch (e) { msg.textContent = "✕ " + e.message; }
  }

  async function lockVault() {
    await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/lock", { method: "POST" });
    renderVaultBody();
  }

  async function addEntry() {
    const body = {
      domain: document.getElementById("vDomain").value.trim(),
      username: document.getElementById("vUser").value.trim() || null,
      password: document.getElementById("vPass").value || null,
      notes: document.getElementById("vNotes").value.trim() || null
    };
    if (!body.domain) { alert("domain required"); return; }
    const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.ok) renderVaultBody();
    else alert("✕ " + (j.error || "failed"));
  }

  async function captureCookies() {
    const msg = document.getElementById("vCapMsg");
    const domain = document.getElementById("vCapDomain").value.trim();
    if (!domain) { msg.textContent = "domain required"; return; }
    if (!state.sessionId) { msg.textContent = "no active session"; return; }
    msg.textContent = "capturing…";
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/vault/save-cookies/" + state.sessionId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain })
      });
      const j = await r.json();
      if (j.ok) {
        msg.textContent = `✓ saved ${j.savedCookies} cookies for ${j.domain}`;
        setTimeout(renderVaultBody, 800);
      } else {
        msg.textContent = "✕ " + (j.error || "failed");
      }
    } catch (e) { msg.textContent = "✕ " + e.message; }
  }

  // ===== Watches panel =====
  async function showWatches() {
    if (document.getElementById("drvWatchesOverlay")) return;
    const div = document.createElement("div");
    div.id = "drvWatchesOverlay";
    div.className = "help-overlay";
    div.innerHTML = `
      <div class="help-card" style="max-width:720px;">
        <button class="help-close" id="drvWatchesClose" aria-label="Close">×</button>
        <h2>Watches <span class="muted small">(URL monitors)</span></h2>
        <p class="muted small">Each Watch opens a real browser, checks a condition on a schedule, and pings you when it fires. Amazon prices, property pages, anything that changes.</p>

        <div class="watch-form-wrap">
          <details>
            <summary><b>+ New watch</b></summary>
            <div class="watch-form" id="drvWatchForm">
              <label>Name <input type="text" id="wName" placeholder="e.g. 'Kindle Oasis price'"/></label>
              <label>URL <input type="text" id="wUrl" placeholder="https://..."/></label>
              <label>CSS selector (optional)
                <input type="text" id="wSel" placeholder="e.g. .a-price-whole — leave blank for whole page"/>
              </label>
              <div class="row2">
                <label>Schedule
                  <select id="wSched">
                    <option value="15m">every 15 minutes</option>
                    <option value="30m">every 30 minutes</option>
                    <option value="1h" selected>every hour</option>
                    <option value="3h">every 3 hours</option>
                    <option value="6h">every 6 hours</option>
                    <option value="12h">every 12 hours</option>
                    <option value="daily">once a day</option>
                  </select>
                </label>
                <label>Condition
                  <select id="wCond">
                    <option value="change">any change</option>
                    <option value="price-below">price drops below…</option>
                    <option value="price-above">price rises above…</option>
                    <option value="text-contains">text contains…</option>
                    <option value="text-not-contains">text NO longer contains… (e.g. "Out of stock")</option>
                    <option value="element-appeared">element appears</option>
                    <option value="element-disappeared">element disappears</option>
                  </select>
                </label>
              </div>
              <label id="wValueLabel" style="display:none;">Value <input type="text" id="wValue" placeholder=""/></label>
              <fieldset class="watch-notify">
                <legend>Notify by</legend>
                <label><input type="checkbox" id="wNotifyLog" checked/> server log</label>
                <label><input type="checkbox" id="wNotifySpeak"/> Kokoro speak</label>
                <label><input type="checkbox" id="wNotifyTodo"/> push to claude-todo</label>
              </fieldset>
              <button id="wCreate" class="primary">Create watch</button>
              <span id="wMsg" class="muted small"></span>
            </div>
          </details>
        </div>

        <div id="drvWatchesList"><p class="muted small">Loading…</p></div>
      </div>`;
    document.body.appendChild(div);
    document.getElementById("drvWatchesClose").onclick = () => div.remove();
    div.addEventListener("click", (e) => { if (e.target === div) div.remove(); });

    // Show/hide the "value" field based on selected condition
    const condEl = document.getElementById("wCond");
    const valWrap = document.getElementById("wValueLabel");
    const valInput = document.getElementById("wValue");
    const updateValueField = () => {
      const c = condEl.value;
      if (c === "price-below" || c === "price-above") {
        valWrap.style.display = "";
        valInput.placeholder = "e.g. 250 (the threshold price)";
        valInput.type = "number";
      } else if (c === "text-contains" || c === "text-not-contains") {
        valWrap.style.display = "";
        valInput.placeholder = "e.g. 'In stock' or 'Out of stock'";
        valInput.type = "text";
      } else {
        valWrap.style.display = "none";
      }
    };
    condEl.addEventListener("change", updateValueField);
    updateValueField();

    document.getElementById("wCreate").onclick = async () => {
      const msg = document.getElementById("wMsg");
      msg.textContent = "creating…";
      try {
        const body = {
          name: document.getElementById("wName").value.trim() || "Untitled watch",
          url: document.getElementById("wUrl").value.trim(),
          selector: document.getElementById("wSel").value.trim() || null,
          schedule: document.getElementById("wSched").value,
          condition: {
            type: condEl.value,
            value: valWrap.style.display !== "none" ? valInput.value : undefined
          },
          notify: [
            document.getElementById("wNotifyLog").checked ? "log" : null,
            document.getElementById("wNotifySpeak").checked ? "speak" : null,
            document.getElementById("wNotifyTodo").checked ? "todo" : null
          ].filter(Boolean)
        };
        const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const j = await r.json();
        if (j.ok) {
          msg.textContent = "created ✓";
          document.getElementById("wName").value = "";
          document.getElementById("wUrl").value = "";
          document.getElementById("wSel").value = "";
          document.getElementById("wValue").value = "";
          renderList();
        } else {
          msg.textContent = "✕ " + (j.error || "failed");
        }
      } catch (e) {
        msg.textContent = "✕ " + e.message;
      }
    };

    async function renderList() {
      const wrap = document.getElementById("drvWatchesList");
      try {
        const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches");
        const j = await r.json();
        if (!j.watches || j.watches.length === 0) {
          wrap.innerHTML = `<p class="muted">No watches yet. Use the form above to create one.</p>`;
          return;
        }
        wrap.innerHTML = j.watches.map(w => watchCard(w)).join("");
        wrap.addEventListener("click", onWatchAction, { once: true });
      } catch (e) {
        wrap.innerHTML = `<div class="diag-banner fail">Couldn't load: ${esc(e.message)}</div>`;
      }
    }

    function watchCard(w) {
      const dot = w.lastError ? "red" : w.enabled ? "green" : "amber";
      const condText = describeCondition(w.condition);
      const last = w.lastChecked
        ? "checked " + relTime(w.lastChecked) + (w.lastError ? ` — <span style="color:#b13a3a">${esc(w.lastError.slice(0, 60))}</span>` : ` — ${esc(JSON.stringify(w.lastValue).slice(0, 60))}`)
        : "not checked yet";
      const next = w.nextCheck ? "next " + relTime(w.nextCheck) : "paused";
      return `
        <div class="watch-card" data-id="${esc(w.id)}">
          <div class="watch-head">
            <span class="srow-dot ${dot}"></span>
            <b>${esc(w.name)}</b>
            <span class="pill">${esc(w.schedule)}</span>
            ${w.lastNotified ? `<span class="pill" style="background:#e8f6ea;color:#1c6b2b;">fired ${esc(relTime(w.lastNotified))}</span>` : ""}
          </div>
          <div class="watch-meta">
            <small>${esc(condText)} ${w.selector ? " · selector <code>" + esc(w.selector) + "</code>" : ""}</small><br/>
            <small><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.url)}</a></small><br/>
            <small class="muted">${last} · ${next}</small>
          </div>
          <div class="watch-actions">
            <button data-act="run" data-id="${esc(w.id)}">Run now</button>
            <button data-act="toggle" data-id="${esc(w.id)}">${w.enabled ? "Pause" : "Resume"}</button>
            <button data-act="delete" data-id="${esc(w.id)}" class="danger">Delete</button>
          </div>
        </div>`;
    }

    function describeCondition(c) {
      if (!c) return "any change";
      switch (c.type) {
        case "change": return "any change";
        case "price-below": return `price drops below £${c.value}`;
        case "price-above": return `price rises above £${c.value}`;
        case "text-contains": return `text contains "${c.value}"`;
        case "text-not-contains": return `text NO longer contains "${c.value}"`;
        case "element-appeared": return "element appears";
        case "element-disappeared": return "element disappears";
        default: return c.type;
      }
    }

    function relTime(iso) {
      const ms = Date.now() - new Date(iso).getTime();
      const abs = Math.abs(ms);
      const future = ms < 0;
      const v = abs < 60000 ? "just now"
        : abs < 3600000 ? Math.round(abs / 60000) + "m"
        : abs < 86400000 ? Math.round(abs / 3600000) + "h"
        : Math.round(abs / 86400000) + "d";
      if (v === "just now") return v;
      return future ? "in " + v : v + " ago";
    }

    async function onWatchAction(e) {
      const btn = e.target.closest("button[data-act]");
      const wrap = document.getElementById("drvWatchesList");
      if (!btn || !wrap) { wrap?.addEventListener("click", onWatchAction, { once: true }); return; }
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      btn.disabled = true;
      try {
        if (act === "run") {
          btn.textContent = "Running…";
          await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches/" + id + "/run-now", { method: "POST" });
        } else if (act === "toggle") {
          const cur = (await (await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches")).json()).watches.find(w => w.id === id);
          await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches/" + id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !cur.enabled })
          });
        } else if (act === "delete") {
          if (!confirm("Delete this watch?")) { btn.disabled = false; wrap.addEventListener("click", onWatchAction, { once: true }); return; }
          await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/watches/" + id, { method: "DELETE" });
        }
      } finally {
        renderList();
      }
    }

    renderList();
  }

  async function showSkills() {
    if (document.getElementById("drvSkillsOverlay")) return;
    const div = document.createElement("div");
    div.id = "drvSkillsOverlay";
    div.className = "help-overlay";
    div.innerHTML = `
      <div class="help-card" style="max-width:620px;">
        <button class="help-close" id="drvSkillsClose" aria-label="Close">×</button>
        <h2>Skills <span class="muted small">(pure-Playwright scrapers)</span></h2>
        <p class="muted small">No LLM. Each Skill is a saved recipe that opens real pages, extracts events, and merges them into the days-out app.</p>
        <div id="drvSkillsList"><p>Loading…</p></div>
        <div class="skills-actions">
          <label><input type="checkbox" id="drvSkillSpeak" /> Speak the summary when done</label>
          <button id="drvRunAll" class="primary">▶ Run all daily skills</button>
        </div>
        <div id="drvSkillsLog" class="skills-log"></div>
      </div>`;
    document.body.appendChild(div);
    document.getElementById("drvSkillsClose").onclick = () => div.remove();
    div.addEventListener("click", (e) => { if (e.target === div) div.remove(); });

    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/skills");
      const j = await r.json();
      const list = document.getElementById("drvSkillsList");
      if (!j.skills || j.skills.length === 0) {
        list.innerHTML = `<p class="muted">No Skills installed yet. Drop a .js file in <code>APPS/cleanweb-engine/skills/</code> and reload.</p>`;
      } else {
        list.innerHTML = j.skills.map(s => `
          <div class="skill-row" data-id="${esc(s.id)}">
            <div>
              <b>${esc(s.name)}</b>
              <span class="pill" style="margin-left:6px;">${esc(s.schedule || "manual")}</span>
              <br/><small class="muted">${esc(s.description || "")}</small>
            </div>
            <button class="ghost run-skill" data-id="${esc(s.id)}">Run</button>
          </div>
        `).join("");
        list.addEventListener("click", async (e) => {
          const btn = e.target.closest(".run-skill");
          if (!btn) return;
          const id = btn.getAttribute("data-id");
          const speakIt = document.getElementById("drvSkillSpeak").checked;
          btn.textContent = "Running…";
          btn.disabled = true;
          await runSkillByApi(id, { merge: true, speak: speakIt });
          btn.textContent = "Run again";
          btn.disabled = false;
        });
      }
    } catch (e) {
      document.getElementById("drvSkillsList").innerHTML =
        `<div class="diag-banner fail">Couldn't reach the engine: ${esc(e.message)}</div>`;
    }

    document.getElementById("drvRunAll").onclick = async () => {
      const btn = document.getElementById("drvRunAll");
      const speakIt = document.getElementById("drvSkillSpeak").checked;
      btn.textContent = "Running all…";
      btn.disabled = true;
      try {
        const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/skills/run-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merge: true, speak: speakIt })
        });
        const j = await r.json();
        appendSkillLog(`✓ ran ${j.ranked} skill(s), ${j.totalEvents} events, ${j.failed} failed`);
        if (j.merge?.wrote) {
          appendSkillLog(`merged into events.json — total now ${j.merge.total}`);
        }
      } catch (e) {
        appendSkillLog(`✕ ${e.message}`);
      } finally {
        btn.textContent = "▶ Run all daily skills";
        btn.disabled = false;
      }
    };
  }

  async function runSkillByApi(id, { merge = true, speak = false } = {}) {
    appendSkillLog(`▶ ${id} …`);
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/skills/" + id + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merge, speak })
      });
      const j = await r.json();
      if (j.ok) {
        appendSkillLog(`✓ ${id}: ${j.eventCount} events in ${Math.round(j.elapsedMs/1000)}s`);
        if (j.merge?.wrote) appendSkillLog(`   merged — total events.json now ${j.merge.total}`);
      } else {
        appendSkillLog(`✕ ${id}: ${j.error}`);
      }
    } catch (e) {
      appendSkillLog(`✕ ${id}: ${e.message}`);
    }
  }

  function appendSkillLog(msg) {
    const log = document.getElementById("drvSkillsLog");
    if (!log) return;
    const div = document.createElement("div");
    div.textContent = msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function runDiagnostics() {
    if (document.getElementById("drvDiagOverlay")) return;
    const div = document.createElement("div");
    div.id = "drvDiagOverlay";
    div.className = "help-overlay";
    div.innerHTML = `
      <div class="help-card">
        <button class="help-close" id="drvDiagClose" aria-label="Close">×</button>
        <h2>Diagnostics</h2>
        <p class="muted small">Checking every layer end-to-end. ~10 seconds.</p>
        <div id="drvDiagList"><p>Running…</p></div>
      </div>`;
    document.body.appendChild(div);
    document.getElementById("drvDiagClose").onclick = () => div.remove();
    div.addEventListener("click", (e) => { if (e.target === div) div.remove(); });
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/diagnose", { cache: "no-store" });
      const j = await r.json();
      const html = j.steps.map(s =>
        `<div class="diag-step ${s.ok ? "ok" : "fail"}">
          <span class="diag-mark">${s.ok ? "✓" : "✕"}</span>
          <div><b>${esc(s.name)}</b><br/><small>${esc(s.detail)}</small></div>
        </div>`
      ).join("");
      const banner = j.ok
        ? `<div class="diag-banner ok">All systems go. The engine, LM Studio, the model, and Playwright are all working.</div>`
        : `<div class="diag-banner fail">Something's broken — see below.${j.hint ? "<br/><small>" + esc(j.hint) + "</small>" : ""}</div>`;
      document.getElementById("drvDiagList").innerHTML = banner + html;
    } catch (e) {
      document.getElementById("drvDiagList").innerHTML =
        `<div class="diag-banner fail">Couldn't reach the engine at <code>${esc(cfg.engineUrl)}</code>.<br/>${esc(e.message)}</div>`;
    }
  }

  function showHelp() {
    if (document.getElementById("drvHelpOverlay")) return;
    const div = document.createElement("div");
    div.id = "drvHelpOverlay";
    div.className = "help-overlay";
    div.innerHTML = `
      <div class="help-card" style="max-width:680px;">
        <button class="help-close" id="drvHelpClose" aria-label="Close">×</button>
        <h2>Help</h2>

        <div class="help-tabs">
          <button class="help-tab active" data-tab="ask">💬 Ask Help</button>
          <button class="help-tab" data-tab="quick">⚡ Quick start</button>
          <button class="help-tab" data-tab="reference">📖 Button reference</button>
          <button class="help-tab" data-tab="full">📄 Full guide</button>
        </div>

        <div class="help-pane" data-pane="ask">
          <p class="muted small">Type a question and the local AI answers from HELP.md. Try things like:</p>
          <div class="help-examples">
            <button class="help-ex" data-q="How do I watch an Amazon price?">How do I watch an Amazon price?</button>
            <button class="help-ex" data-q="How do I scrape Facebook events for a venue?">Facebook events for a venue</button>
            <button class="help-ex" data-q="What does the ✏️ Draw to ask button do?">What does Draw-to-ask do?</button>
            <button class="help-ex" data-q="How do I add a new Skill?">How do I add a new Skill?</button>
            <button class="help-ex" data-q="My watch never fires — what should I check?">My watch never fires</button>
            <button class="help-ex" data-q="How do I schedule daily scraping?">Schedule daily scraping</button>
          </div>
          <div class="help-chat" id="helpChat"></div>
          <div class="help-input-row">
            <input type="text" id="helpQuestion" placeholder="Ask anything about Cleanweb…" />
            <button id="helpAskSend" class="primary">Ask</button>
          </div>
        </div>

        <div class="help-pane drv-hidden" data-pane="quick">
          <h3>First-time setup (do this once)</h3>
          <ol>
            <li>Make sure the engine is running. ⚡ Diagnostics should be all green.</li>
            <li>Pick which model is loaded in LM Studio — phi-4-14b-instruct-sft is the default.</li>
            <li>Open the 🔐 Vault and create a PIN if you'll be using social-media skills.</li>
          </ol>

          <h3>The three flows you'll use most</h3>
          <ol>
            <li><b>One-off browsing</b> — ▶ Start session → type what you want → watch it work.</li>
            <li><b>Watch a page</b> — 👁 Watches → + New watch → fill in URL, schedule, condition.</li>
            <li><b>Daily scraping</b> — 🛠 Skills → Run all daily skills. Or schedule the CLI in cron.</li>
          </ol>

          <h3>Status dots</h3>
          <ul>
            <li><span class="leg green"></span> <b>green</b> — working / connected</li>
            <li><span class="leg amber"></span> <b>amber</b> — checking / partly known</li>
            <li><span class="leg red"></span> <b>red</b> — not reachable, check ⚡ Diagnostics</li>
          </ul>
        </div>

        <div class="help-pane drv-hidden" data-pane="reference">
          <table class="help-table">
            <tr><th>Button</th><th>What it does</th></tr>
            <tr><td><b>🔐 Vault</b></td><td>PIN-encrypted store for logins and cookies that Skills use to scrape logged-in pages.</td></tr>
            <tr><td><b>👁 Watches</b></td><td>URL monitors. Pick a schedule + condition, get pinged when it fires. Amazon prices, listings, anything that changes.</td></tr>
            <tr><td><b>🛠 Skills</b></td><td>Pure-Playwright recipes. No LLM. Fast, reliable. Run on demand or schedule. Output merges into the days-out app.</td></tr>
            <tr><td><b>⚡ Diagnostics</b></td><td>Verifies LM Studio, the loaded model, tool calling, and Playwright — in 10 seconds.</td></tr>
            <tr><td><b>?</b></td><td>This help. Ask Help tab lets you chat with the docs.</td></tr>
            <tr><td><b>▶ Start session</b></td><td>Opens a real Chromium tab on the Mac mini. Required before chat or draw-to-ask.</td></tr>
            <tr><td><b>✏️ Draw to ask</b></td><td>(In a session) drag a box on the live browser, ask a question about that region.</td></tr>
          </table>

          <h3>Condition types for Watches</h3>
          <ul>
            <li><b>any change</b> — fires when text changes</li>
            <li><b>price drops below / rises above</b> — parses currency, fires once per crossing</li>
            <li><b>text contains / NO longer contains</b> — for "In stock" / "Out of stock" style</li>
            <li><b>element appeared / disappeared</b> — selector-based existence check</li>
          </ul>
        </div>

        <div class="help-pane drv-hidden" data-pane="full">
          <p class="muted small">Loading full HELP.md…</p>
          <div id="helpFullText" class="help-full"></div>
        </div>
      </div>
    `;
    document.body.appendChild(div);
    document.getElementById("drvHelpClose").onclick = () => div.remove();
    div.addEventListener("click", (e) => { if (e.target === div) div.remove(); });

    // Tab switching
    div.querySelectorAll(".help-tab").forEach(t => {
      t.onclick = () => {
        div.querySelectorAll(".help-tab").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        const tab = t.getAttribute("data-tab");
        div.querySelectorAll(".help-pane").forEach(p => {
          p.classList.toggle("drv-hidden", p.getAttribute("data-pane") !== tab);
        });
        if (tab === "full") loadFullHelp();
      };
    });

    // Ask Help wiring
    div.querySelectorAll(".help-ex").forEach(b => {
      b.onclick = () => {
        document.getElementById("helpQuestion").value = b.getAttribute("data-q");
        askHelp();
      };
    });
    document.getElementById("helpAskSend").onclick = askHelp;
    document.getElementById("helpQuestion").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); askHelp(); }
    });
    document.getElementById("helpQuestion").focus();
  }

  async function askHelp() {
    const q = document.getElementById("helpQuestion").value.trim();
    if (!q) return;
    const chat = document.getElementById("helpChat");
    const btn = document.getElementById("helpAskSend");
    btn.disabled = true;
    btn.textContent = "Thinking…";
    document.getElementById("helpQuestion").value = "";

    const userMsg = document.createElement("div");
    userMsg.className = "help-msg user";
    userMsg.textContent = q;
    chat.appendChild(userMsg);
    chat.scrollTop = chat.scrollHeight;

    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/help/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q })
      });
      const j = await r.json();
      const agentMsg = document.createElement("div");
      agentMsg.className = "help-msg agent";
      if (j.ok) {
        // Light markdown — preserve newlines and bold.
        let html = esc(j.answer)
          .replace(/\n/g, "<br/>")
          .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
        agentMsg.innerHTML = html;
      } else {
        agentMsg.classList.add("error");
        agentMsg.textContent = "✕ " + (j.error || "ask-help failed");
      }
      chat.appendChild(agentMsg);
      chat.scrollTop = chat.scrollHeight;
    } catch (e) {
      const errMsg = document.createElement("div");
      errMsg.className = "help-msg error";
      errMsg.textContent = "✕ " + e.message;
      chat.appendChild(errMsg);
    } finally {
      btn.disabled = false;
      btn.textContent = "Ask";
    }
  }

  let helpFullLoaded = false;
  async function loadFullHelp() {
    if (helpFullLoaded) return;
    helpFullLoaded = true;
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/help");
      const md = await r.text();
      // Minimal markdown-to-HTML: headings, lists, code, bold, links.
      const html = md
        .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
        .replace(/^### (.+)$/gm, "<h4>$1</h4>")
        .replace(/^## (.+)$/gm, "<h3>$1</h3>")
        .replace(/^# (.+)$/gm, "<h2>$1</h2>")
        .replace(/^\* (.+)$/gm, "<li>$1</li>")
        .replace(/^- (.+)$/gm, "<li>$1</li>")
        .replace(/(<li>.*<\/li>\n?)+/g, (m) => "<ul>" + m + "</ul>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/\n\n/g, "</p><p>");
      document.getElementById("helpFullText").innerHTML = "<p>" + html + "</p>";
    } catch (e) {
      document.getElementById("helpFullText").innerHTML = `<div class="diag-banner fail">Couldn't load: ${esc(e.message)}</div>`;
    }
  }

  // ---------- session control ----------
  async function startSession() {
    if (state.busy) return;
    state.busy = true;
    $("drvStart").disabled = true;
    setStatus("starting…", "busy");
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "about:blank" })
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      state.sessionId = j.sessionId;
      connectStreams();
      setStatus("live", "on");
      $("drvStart").classList.add("drv-hidden");
      $("drvStop").classList.remove("drv-hidden");
      $("drvMsg").disabled = false;
      $("drvMsg").placeholder = "Tell me what to do… (try an example above)";
      $("drvSend").disabled = false;
      $("drvDrawToggle").disabled = false;
      $("drvPlaceholder").classList.add("drv-hidden");
      $("drvFrame").classList.remove("drv-hidden");
      log("system", "session started · id " + esc(state.sessionId));
      document.getElementById("driveToggleBtn")?.classList.add("live");
    } catch (e) {
      log("error", "Failed to start: " + esc(e.message));
      setStatus("idle");
      $("drvStart").disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function stopSession() {
    if (!state.sessionId) return;
    try { await fetch(cfg.engineUrl.replace(/\/$/, "") + "/api/session/" + state.sessionId, { method: "DELETE" }); } catch {}
    closeStreams();
    state.sessionId = null;
    setStatus("idle");
    $("drvStop").classList.add("drv-hidden");
    $("drvStart").classList.remove("drv-hidden");
    $("drvStart").disabled = false;
    $("drvMsg").disabled = true;
    $("drvSend").disabled = true;
    $("drvDrawToggle").disabled = true;
    setDrawMode(false);
    $("drvFrame").classList.add("drv-hidden");
    $("drvFrame").src = "";
    $("drvPlaceholder").classList.remove("drv-hidden");
    document.getElementById("driveToggleBtn")?.classList.remove("live");
    log("system", "session stopped");
  }

  function connectStreams() {
    const wsBase = cfg.engineUrl.replace(/^http/, "ws").replace(/\/$/, "");
    state.frameWs = new WebSocket(wsBase + "/ws/screencast/" + state.sessionId);
    state.frameWs.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === "frame") {
          $("drvFrame").src = "data:image/jpeg;base64," + m.data;
        }
      } catch {}
    };
    state.frameWs.onclose = () => {};
    state.eventWs = new WebSocket(wsBase + "/ws/events/" + state.sessionId);
    state.eventWs.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind !== "event") return;
        handleEvent(m);
      } catch {}
    };
  }
  function closeStreams() {
    try { state.frameWs?.close(); } catch {}
    try { state.eventWs?.close(); } catch {}
    state.frameWs = null;
    state.eventWs = null;
  }

  function setNowDoing(text) {
    const w = document.getElementById("drvNowDoing");
    const t = document.getElementById("drvNowDoingText");
    if (!w || !t) return;
    if (text) { t.textContent = text; w.classList.remove("drv-hidden"); }
    else { w.classList.add("drv-hidden"); }
  }

  function friendlyAction(action, args, say) {
    if (say) return say;
    if (!args) args = {};
    if (action === "navigate") return "Opening " + (args.url || "page");
    if (action === "click") {
      const target = args.name || args.text || args.label || args.placeholder || args.role || args.selector || "something";
      return "Clicking " + target;
    }
    if (action === "type") {
      const target = args.name || args.label || args.placeholder || "the field";
      return "Typing into " + target;
    }
    if (action === "scroll") return "Scrolling " + (args.direction || "down");
    if (action === "press_key") return "Pressing " + (args.key || "key");
    if (action === "extract_text") return "Reading the page";
    if (action === "wait") return "Waiting";
    return action;
  }

  function handleEvent(e) {
    const t = e.type;
    const p = e.payload || {};
    if (t === "navigate") {
      $("drvUrl").value = p.url || "";
    } else if (t === "agent_action") {
      const friendly = friendlyAction(p.action, p.args, p.say);
      setNowDoing(friendly);
      log("agent", pill(p.action) + esc(friendly));
    } else if (t === "agent_result") {
      if (p.result && p.result.error) {
        log("error", "Hit a snag: " + esc(p.result.error.split("\n")[0]));
      }
    } else if (t === "agent_ask") {
      setNowDoing("Waiting for you");
      showAsk(p.question);
    } else if (t === "agent_done") {
      setNowDoing("");
      log("agent", "<b>✓ Done.</b> " + esc(p.answer || ""));
      setStatus("live", "on");
    } else if (t === "agent_error") {
      setNowDoing("");
      log("error", "Agent error: " + esc(p.error || ""));
      setStatus("live", "on");
    } else if (t === "agent_capped") {
      setNowDoing("");
      log("error", "Ran out of steps (cap " + esc(p.maxSteps) + ") — try a smaller task or be more specific.");
      setStatus("live", "on");
    }
  }

  function summariseArgs(action, args) {
    if (!args || typeof args !== "object") return "";
    if (action === "navigate") return args.url || "";
    if (action === "type") {
      const target = args.name || args.label || args.placeholder || args.selector || args.text || "";
      return (target ? target + " ← " : "") + JSON.stringify(args.value || "");
    }
    if (action === "click") {
      return args.name || args.text || args.label || args.placeholder || args.selector || JSON.stringify(args);
    }
    if (action === "scroll") return `${args.direction || "down"} ${args.amount || 500}`;
    if (action === "press_key") return args.key || "";
    if (action === "extract_text") return args.selector || "(page)";
    if (action === "wait") return (args.ms || 0) + "ms";
    return JSON.stringify(args);
  }

  function showAsk(question) {
    const wrap = $("drvAskWrap");
    wrap.innerHTML = `
      <div class="ask">
        <p>${esc(question)}</p>
        <div class="row">
          <input type="text" id="drvAskInput" />
          <button id="drvAskSend">Reply</button>
        </div>
      </div>`;
    const send = async () => {
      const reply = $("drvAskInput").value.trim();
      if (!reply) return;
      await fetch(cfg.engineUrl.replace(/\/$/, "") + `/api/session/${state.sessionId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply })
      });
      log("user", "(answered) " + esc(reply));
      wrap.innerHTML = "";
    };
    $("drvAskSend").onclick = send;
    $("drvAskInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    $("drvAskInput").focus();
  }

  async function go() {
    if (!state.sessionId) return;
    const url = $("drvUrl").value.trim();
    if (!url) return;
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + `/api/session/${state.sessionId}/navigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const j = await r.json();
      if (j.error) log("error", "navigate: " + esc(j.error));
    } catch (e) {
      log("error", "navigate: " + esc(e.message));
    }
  }

  async function send() {
    if (!state.sessionId) return;
    const instruction = $("drvMsg").value.trim();
    if (!instruction) return;
    hideWelcome();
    log("user", esc(instruction));
    $("drvMsg").value = "";
    $("drvSend").disabled = true;
    setStatus("thinking…", "busy");
    setNowDoing("Reading the page…");
    try {
      const r = await fetch(cfg.engineUrl.replace(/\/$/, "") + `/api/session/${state.sessionId}/instruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction })
      });
      const j = await r.json();
      if (j.error) log("error", "instruct: " + esc(j.error));
    } catch (e) {
      log("error", "instruct: " + esc(e.message));
    } finally {
      $("drvSend").disabled = false;
    }
  }

  function open() {
    state.open = true;
    $("driveOverlay").setAttribute("data-open", "true");
    $("drvEngineUrl").value = cfg.engineUrl;
    pingEngine();
  }
  function close() {
    state.open = false;
    $("driveOverlay").setAttribute("data-open", "false");
  }

  // ---------- boot ----------
  function boot() {
    injectTopButton();
    injectOverlay();

    document.getElementById("driveToggleBtn").addEventListener("click", () => {
      state.open ? close() : open();
    });

    $("drvClose").addEventListener("click", close);
    $("drvStart").addEventListener("click", startSession);
    $("drvStop").addEventListener("click", stopSession);
    $("drvGo").addEventListener("click", go);
    $("drvSend").addEventListener("click", send);
    $("drvHelp").addEventListener("click", showHelp);
    $("drvDiag").addEventListener("click", runDiagnostics);
    $("drvSkills").addEventListener("click", showSkills);
    $("drvWatches").addEventListener("click", showWatches);
    $("drvVault").addEventListener("click", showVault);
    $("drvDrawToggle").addEventListener("click", () => setDrawMode(!drawMode));
    const canvas = document.getElementById("drvDrawCanvas");
    canvas.addEventListener("mousedown", onDrawMouseDown);
    canvas.addEventListener("mousemove", onDrawMouseMove);
    canvas.addEventListener("mouseup", onDrawMouseUp);
    canvas.addEventListener("mouseleave", () => { if (drawing) { drawing = false; clearCanvas(); } });
    window.addEventListener("resize", () => { if (drawMode) sizeCanvasToFrame(); });
    $("drvCfgToggle").addEventListener("click", () => {
      $("drvCfg").classList.toggle("drv-hidden");
    });
    $("drvMsg").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $("drvUrl").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    $("drvEngineUrl").addEventListener("change", () => {
      cfg.engineUrl = ($("drvEngineUrl").value || DEFAULT_CFG.engineUrl).trim();
      saveCfg(cfg);
      pingEngine();
    });

    // Tap an example chip — fills the input. If session is live, send straight
    // away; if not, prefill so the user can hit ▶ Start then Send.
    document.addEventListener("click", (e) => {
      const t = e.target.closest(".welcome .ex");
      if (!t) return;
      const q = t.getAttribute("data-q") || "";
      $("drvMsg").value = q;
      $("drvMsg").focus();
      if (state.sessionId) send();
    });

    // ESC closes the overlay.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) close();
    });

    // Clean up when the page unloads.
    window.addEventListener("beforeunload", () => {
      if (state.sessionId) {
        try {
          navigator.sendBeacon(
            cfg.engineUrl.replace(/\/$/, "") + "/api/session/" + state.sessionId,
            new Blob([], { type: "application/json" })
          );
        } catch {}
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

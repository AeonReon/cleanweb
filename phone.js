// ============================================================
// Cleanweb — phone shell
// Chat-first homepage that talks to the same cleanweb-engine that
// Drive Mode uses (/api/session + /api/session/:id/instruct).
// Wave 1: shell + chat passthrough + More menu. No new backend.
// ============================================================

const ENGINE_KEY = "cleanweb.engineUrl";
const THEME_KEY = "cleanweb.theme";
const DEFAULT_ENGINE = "https://cleanweb-engine.aiprofits.cc";

const state = {
  engineUrl: localStorage.getItem(ENGINE_KEY) || DEFAULT_ENGINE,
  sessionId: null,
  sending: false,
  awaitingAnswer: false, // true when the agent is paused on ask_user
};

const $ = (id) => document.getElementById(id);

// ---------- Theme ----------

function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY); // 'light' | 'dark' | null (=system)
  if (saved) document.body.setAttribute("data-theme", saved);
  else document.body.removeAttribute("data-theme");
}

function cycleTheme() {
  const cur = localStorage.getItem(THEME_KEY);
  const next = cur === "light" ? "dark" : cur === "dark" ? "" : "light";
  if (next) localStorage.setItem(THEME_KEY, next);
  else localStorage.removeItem(THEME_KEY);
  applyTheme();
}

// ---------- Screen navigation ----------

function showScreen(name) {
  document.querySelectorAll(".ph-screen").forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });
  window.scrollTo({ top: 0, behavior: "instant" });
}

// ---------- Feed ----------

function pushCard(kind, html) {
  const welcome = $("phWelcome");
  if (welcome && !welcome.dataset.dismissed) {
    welcome.style.display = "none";
    welcome.dataset.dismissed = "1";
  }
  const card = document.createElement("div");
  card.className = "ph-card " + kind;
  card.innerHTML = html;
  $("phFeed").appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Engine ----------

async function api(path, init = {}) {
  const url = state.engineUrl.replace(/\/$/, "") + path;
  const r = await fetch(url, { credentials: "include", ...init });
  return r;
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const r = await api("/api/session", { method: "POST" });
  if (!r.ok) {
    if (r.status === 401) throw new Error("Cleanweb is locked. Open Drive Mode once to enter the PIN, then come back.");
    throw new Error("Engine refused to start a session (HTTP " + r.status + ").");
  }
  const j = await r.json();
  state.sessionId = j.id || j.sessionId;
  if (!state.sessionId) throw new Error("Engine didn't return a session id.");
  return state.sessionId;
}

function renderAgentReply(card, j) {
  if (j.paused && j.question) {
    state.awaitingAnswer = true;
    card.innerHTML =
      `<div class="ph-card-meta">cleanweb is asking</div>` +
      escapeHtml(j.question).replace(/\n/g, "<br>") +
      `<div class="ph-card-meta" style="margin-top:10px;opacity:0.7;">Reply below to continue</div>`;
    $("phInput").placeholder = "Your answer…";
    return;
  }
  state.awaitingAnswer = false;
  $("phInput").placeholder = "Say what you'd like done…";
  const answer = j.answer || j.reply || j.message || j.result || (j.ok === false ? (j.error || "(no reply)") : "(no reply)");
  card.innerHTML = `<div class="ph-card-meta">cleanweb</div>${escapeHtml(answer).replace(/\n/g, "<br>")}`;
}

async function sendMessage(text) {
  if (state.sending) return;
  state.sending = true;
  $("phSend").disabled = true;

  pushCard("user", escapeHtml(text));
  const thinking = pushCard("agent", `<div class="ph-card-meta">cleanweb</div>working on it…`);

  try {
    // If the agent paused on a question, route this message to /answer instead of starting a new instruction.
    if (state.awaitingAnswer && state.sessionId) {
      const r = await api(`/api/session/${state.sessionId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: text }),
      });
      if (!r.ok) throw new Error("Engine returned HTTP " + r.status);
      const j = await r.json();
      renderAgentReply(thinking, j);
    } else {
      const id = await ensureSession();
      const r = await api(`/api/session/${id}/instruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
      if (!r.ok) throw new Error("Engine returned HTTP " + r.status);
      const j = await r.json();
      renderAgentReply(thinking, j);
    }
  } catch (e) {
    thinking.innerHTML = `<div class="ph-card-meta">couldn't reach the engine</div>${escapeHtml(e.message)}<br><br><a href="/" style="color:inherit;text-decoration:underline;">Open Drive Mode to fix this</a>`;
  } finally {
    state.sending = false;
    $("phSend").disabled = false;
    $("phInput").value = "";
    autoSize($("phInput"));
  }
}

// ---------- Input UX ----------

function autoSize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
}

// ---------- Tile routing ----------

// All manual tools currently live inside Drive Mode on the desktop view.
// Wave 1: route taps back to / with a hash so the desktop loader opens
// the right overlay. (Desktop app.js can read window.location.hash on load.)
const TOOL_ROUTES = {
  watches:  "/?open=drive#watches",
  skills:   "/?open=drive#skills",
  vault:    "/?open=drive#vault",
  drive:    "/?open=drive",
  search:   "/",
  settings: "/?open=drive#settings",
};

function openTool(tool) {
  const route = TOOL_ROUTES[tool] || "/";
  location.href = route;
}

// ---------- Wire-up ----------

function init() {
  applyTheme();

  $("phThemeBtn").addEventListener("click", cycleTheme);
  $("phMoreBtn").addEventListener("click", () => showScreen("more"));
  $("phMoreBack").addEventListener("click", () => showScreen("home"));

  document.querySelectorAll(".ph-tile").forEach((tile) => {
    tile.addEventListener("click", () => openTool(tile.dataset.tool));
  });

  document.querySelectorAll(".ph-ex").forEach((chip) => {
    chip.addEventListener("click", () => {
      const txt = chip.dataset.ex;
      $("phInput").value = txt;
      autoSize($("phInput"));
      sendMessage(txt);
    });
  });

  const ta = $("phInput");
  ta.addEventListener("input", () => autoSize(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = ta.value.trim();
      if (v) sendMessage(v);
    }
  });

  $("phInputRow").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = ta.value.trim();
    if (v) sendMessage(v);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

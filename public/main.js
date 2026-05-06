// Mobile-friendly xterm.js client. Stores the bearer token in
// sessionStorage so a refresh keeps the session, but doesn't persist
// across browser restarts.

const STATUS_EL = document.getElementById("status");
const HEADER_EL = document.querySelector("header");
const TERM_HOST = document.getElementById("term-host");
const LOGIN_EL = document.getElementById("login");
const TOKEN_INPUT = document.getElementById("token");
const CONNECT_BTN = document.getElementById("connect");
const LOGIN_ERR = document.getElementById("login-err");
const FILES_BTN = document.getElementById("files-btn");
const PANEL_EL = document.getElementById("panel");
const PANEL_CLOSE = document.getElementById("panel-close");
const FILE_LIST = document.getElementById("file-list");
const DIFF_VIEW = document.getElementById("diff-view");
const COMMIT_MSG = document.getElementById("commit-msg");
const COMMIT_BTN = document.getElementById("commit-btn");
const COMMIT_STATUS = document.getElementById("commit-status");
const VOICE_BTN = document.getElementById("voice-btn");
const COMPOSE = document.getElementById("compose");
const COMPOSE_TEXT = document.getElementById("compose-text");
const COMPOSE_SEND = document.getElementById("compose-send");
const COMPOSE_CANCEL = document.getElementById("compose-cancel");
const COMPOSE_HINT = document.getElementById("compose-hint");

let bearerToken = null;
let activeFile = null;
let pollHandle = null;
let activeWs = null;

const cached = sessionStorage.getItem("baton-web-token");
if (cached) {
  TOKEN_INPUT.value = cached;
  // Auto-connect if we have a token from this session
  setTimeout(() => connect(cached), 0);
}

CONNECT_BTN.addEventListener("click", () => {
  const t = TOKEN_INPUT.value.trim();
  if (!t) {
    LOGIN_ERR.textContent = "token required";
    return;
  }
  connect(t);
});

TOKEN_INPUT.addEventListener("keydown", (e) => {
  if (e.key === "Enter") CONNECT_BTN.click();
});

function setStatus(label, kind) {
  STATUS_EL.textContent = label;
  STATUS_EL.classList.remove("connected", "disconnected");
  STATUS_EL.classList.add(kind);
}

function connect(token) {
  LOGIN_ERR.textContent = "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/term?token=${encodeURIComponent(token)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    LOGIN_ERR.textContent = "failed to open websocket";
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: "#0a0a0a",
      foreground: "#f5f5f5",
      cursor: "#6366f1",
      selectionBackground: "#3b3b3b",
    },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(TERM_HOST);

  const sendResize = () => {
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
      );
    }
  };

  ws.addEventListener("open", () => {
    sessionStorage.setItem("baton-web-token", token);
    bearerToken = token;
    activeWs = ws;
    LOGIN_EL.style.display = "none";
    HEADER_EL.style.display = "flex";
    TERM_HOST.style.display = "block";
    VOICE_BTN.style.display = SpeechRecognitionCtor() ? "flex" : "none";
    setStatus("connected", "connected");
    setTimeout(sendResize, 50);
    term.focus();
    startStatusPolling();
    probeBatonAvailability();
  });

  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      term.write(e.data);
    } else {
      // Binary frames (rare from this server but possible)
      e.data.text().then((s) => term.write(s));
    }
  });

  ws.addEventListener("close", (e) => {
    setStatus(`offline (${e.code})`, "disconnected");
    term.write("\r\n\x1b[33m[baton-web] connection closed\x1b[0m\r\n");
    stopStatusPolling();
    activeWs = null;
    VOICE_BTN.style.display = "none";
  });

  ws.addEventListener("error", () => {
    LOGIN_ERR.textContent =
      "websocket error — wrong token, server down, or HTTPS/WS mismatch";
    LOGIN_EL.style.display = "flex";
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  // Keep terminal sized to viewport on rotate / soft-keyboard show.
  window.addEventListener("resize", sendResize);
  // Mobile soft-keyboard frequently changes the visualViewport without
  // firing a resize. Listen there too.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", sendResize);
  }
}

// ---------------------------------------------------------------------
// Files & diff panel
// ---------------------------------------------------------------------

FILES_BTN.addEventListener("click", () => {
  PANEL_EL.classList.add("open");
  PANEL_EL.setAttribute("aria-hidden", "false");
  refreshTree();
});

PANEL_CLOSE.addEventListener("click", () => {
  PANEL_EL.classList.remove("open");
  PANEL_EL.setAttribute("aria-hidden", "true");
});

async function api(path) {
  const res = await fetch(path, {
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function startStatusPolling() {
  stopStatusPolling();
  pollHandle = setInterval(refreshStatus, 4000);
  refreshStatus();
}

function stopStatusPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function refreshStatus() {
  try {
    const { status } = await api("/api/status");
    const dirty = status.length > 0;
    FILES_BTN.classList.toggle("dirty", dirty);
    if (PANEL_EL.classList.contains("open")) {
      // Re-render tree if the panel is open so badges stay fresh.
      await refreshTree();
    }
  } catch (e) {
    // network / auth failure — leave the dot as-is
  }
}

async function refreshTree() {
  try {
    const { tree } = await api("/api/tree");
    renderTree(tree);
  } catch (e) {
    FILE_LIST.innerHTML = `<div class="empty">error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTree(tree) {
  if (tree.length === 0) {
    FILE_LIST.innerHTML = `<div class="empty">no tracked or untracked files</div>`;
    return;
  }
  // Show changed files first, alphabetical within each group.
  const dirty = tree.filter((t) => t.status);
  const clean = tree.filter((t) => !t.status);
  const all = [...dirty, ...clean];
  FILE_LIST.innerHTML = "";
  for (const f of all) {
    const row = document.createElement("div");
    row.className = "file-row" + (f.path === activeFile ? " active" : "");
    const code = (f.status || "").trim() || "";
    row.innerHTML = `
      <span class="badge ${code ? code : "empty"}">${code || "·"}</span>
      <span class="path"></span>
    `;
    row.querySelector(".path").textContent = f.path;
    row.addEventListener("click", () => openFile(f.path));
    FILE_LIST.appendChild(row);
  }
}

async function openFile(path) {
  activeFile = path;
  // mark active row
  for (const r of FILE_LIST.querySelectorAll(".file-row")) {
    r.classList.toggle(
      "active",
      r.querySelector(".path")?.textContent === path
    );
  }
  DIFF_VIEW.innerHTML = `<div class="empty">loading diff…</div>`;
  try {
    const { diff, mode } = await api(
      `/api/diff?path=${encodeURIComponent(path)}`
    );
    if (mode === "no-change") {
      // No diff against HEAD — show file content instead so the user sees something.
      const { content } = await api(
        `/api/file?path=${encodeURIComponent(path)}`
      );
      DIFF_VIEW.innerHTML = `<div class="empty" style="text-align:left">no diff vs HEAD; current content:</div>`;
      const pre = document.createElement("div");
      pre.textContent = content;
      DIFF_VIEW.appendChild(pre);
    } else {
      DIFF_VIEW.innerHTML = renderDiff(diff);
    }
  } catch (e) {
    DIFF_VIEW.innerHTML = `<div class="empty">error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderDiff(diff) {
  const lines = diff.split("\n");
  const out = [];
  for (const line of lines) {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) cls = "meta";
    out.push(
      `<div class="${cls}">${escapeHtml(line || " ")}</div>`
    );
  }
  return out.join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// Baton memory integration (v0.4)
// ---------------------------------------------------------------------

const REMEMBER_BTN = document.getElementById("remember-btn");
const REMEMBER_OVERLAY = document.getElementById("remember-overlay");
const REMEMBER_TEXT = document.getElementById("remember-text");
const REMEMBER_TAGS = document.getElementById("remember-tags");
const REMEMBER_SAVE = document.getElementById("remember-save");
const REMEMBER_CANCEL = document.getElementById("remember-cancel");
const REMEMBER_RESULT = document.getElementById("remember-result");

async function probeBatonAvailability() {
  try {
    const r = await api("/api/baton-status");
    if (r.available) {
      REMEMBER_BTN.style.display = "inline-flex";
    }
  } catch {
    // ignore — keep the button hidden
  }
}

REMEMBER_BTN.addEventListener("click", () => {
  REMEMBER_OVERLAY.style.display = "flex";
  REMEMBER_TEXT.value = "";
  REMEMBER_TAGS.value = "";
  REMEMBER_RESULT.textContent = "";
  setTimeout(() => REMEMBER_TEXT.focus(), 50);
});

REMEMBER_CANCEL.addEventListener("click", () => {
  REMEMBER_OVERLAY.style.display = "none";
});

REMEMBER_SAVE.addEventListener("click", async () => {
  const text = (REMEMBER_TEXT.value || "").trim();
  if (!text) {
    REMEMBER_RESULT.textContent = "note required";
    return;
  }
  const tagInput = (REMEMBER_TAGS.value || "").trim();
  const tags = tagInput
    ? tagInput.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  REMEMBER_SAVE.disabled = true;
  REMEMBER_RESULT.textContent = "saving…";
  try {
    const res = await fetch("/api/remember", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text, tags }),
    });
    const body = await res.json();
    if (body.ok) {
      const idLabel = body.id != null ? `id=${body.id}` : "";
      REMEMBER_RESULT.textContent = `saved ${idLabel}`;
      setTimeout(() => (REMEMBER_OVERLAY.style.display = "none"), 700);
    } else {
      REMEMBER_RESULT.textContent = body.output || body.error || "failed";
    }
  } catch (e) {
    REMEMBER_RESULT.textContent = `error: ${e.message || e}`;
  } finally {
    REMEMBER_SAVE.disabled = false;
  }
});


// ---------------------------------------------------------------------
// Commit & push
// ---------------------------------------------------------------------

COMMIT_BTN.addEventListener("click", async () => {
  const message = (COMMIT_MSG.value || "").trim();
  if (!message) {
    COMMIT_STATUS.textContent = "commit message required";
    return;
  }
  COMMIT_BTN.disabled = true;
  COMMIT_STATUS.textContent = "committing…";
  try {
    const res = await fetch("/api/commit-push", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    const body = await res.json();
    const lines = (body.steps || []).map(
      (s) => `[${s.exitCode === 0 ? "✓" : "✗"}] ${s.step}\n${s.output || "(no output)"}`
    );
    COMMIT_STATUS.textContent = lines.join("\n\n");
    if (body.ok) {
      COMMIT_MSG.value = "";
      // Refresh tree + status; everything should be clean now
      refreshStatus();
      refreshTree();
    }
  } catch (e) {
    COMMIT_STATUS.textContent = `error: ${e.message || e}`;
  } finally {
    COMMIT_BTN.disabled = false;
  }
});

COMMIT_MSG.addEventListener("keydown", (e) => {
  if (e.key === "Enter") COMMIT_BTN.click();
});

// ---------------------------------------------------------------------
// Voice input — Web Speech API (Chrome/Safari) → compose textarea
// ---------------------------------------------------------------------

function SpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

let recognition = null;
let recognizing = false;

VOICE_BTN.addEventListener("click", () => {
  // Open compose if it isn't open
  if (COMPOSE.style.display !== "flex") {
    COMPOSE.style.display = "flex";
    COMPOSE.setAttribute("aria-hidden", "false");
    COMPOSE_TEXT.focus();
  }
  toggleDictation();
});

COMPOSE_CANCEL.addEventListener("click", () => {
  stopDictation();
  COMPOSE.style.display = "none";
  COMPOSE.setAttribute("aria-hidden", "true");
  COMPOSE_TEXT.value = "";
});

COMPOSE_SEND.addEventListener("click", () => {
  const text = (COMPOSE_TEXT.value || "").trim();
  if (!text) return;
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    COMPOSE_HINT.textContent = "not connected — reconnect and try again";
    return;
  }
  // Send to the PTY exactly as if the user typed it, then a newline
  activeWs.send(JSON.stringify({ type: "input", data: text + "\r" }));
  stopDictation();
  COMPOSE.style.display = "none";
  COMPOSE.setAttribute("aria-hidden", "true");
  COMPOSE_TEXT.value = "";
});

function toggleDictation() {
  if (recognizing) {
    stopDictation();
    return;
  }
  const Ctor = SpeechRecognitionCtor();
  if (!Ctor) {
    COMPOSE_HINT.textContent =
      "speech recognition not available in this browser";
    return;
  }
  recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  let baseline = COMPOSE_TEXT.value;

  recognition.onstart = () => {
    recognizing = true;
    VOICE_BTN.classList.add("recording");
    COMPOSE_HINT.textContent = "listening… tap mic again to stop";
  };
  recognition.onerror = (e) => {
    COMPOSE_HINT.textContent = `dictation error: ${e.error || "unknown"}`;
    stopDictation();
  };
  recognition.onend = () => {
    recognizing = false;
    VOICE_BTN.classList.remove("recording");
    COMPOSE_HINT.textContent = "tap send to push to the terminal";
  };
  recognition.onresult = (e) => {
    let interim = "";
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (finalText) {
      baseline = (baseline + " " + finalText).trim();
    }
    COMPOSE_TEXT.value = (baseline + (interim ? " " + interim : "")).trim();
  };
  try {
    recognition.start();
  } catch (e) {
    COMPOSE_HINT.textContent = `cannot start dictation: ${e.message || e}`;
  }
}

function stopDictation() {
  if (recognition && recognizing) {
    try {
      recognition.stop();
    } catch {}
  }
  recognizing = false;
  VOICE_BTN.classList.remove("recording");
}

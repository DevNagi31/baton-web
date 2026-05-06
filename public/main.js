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

let bearerToken = null;
let activeFile = null;
let pollHandle = null;

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
    LOGIN_EL.style.display = "none";
    HEADER_EL.style.display = "flex";
    TERM_HOST.style.display = "block";
    setStatus("connected", "connected");
    setTimeout(sendResize, 50);
    term.focus();
    startStatusPolling();
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

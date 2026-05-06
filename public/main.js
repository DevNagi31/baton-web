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
    LOGIN_EL.style.display = "none";
    HEADER_EL.style.display = "flex";
    TERM_HOST.style.display = "block";
    setStatus("connected", "connected");
    setTimeout(sendResize, 50);
    term.focus();
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

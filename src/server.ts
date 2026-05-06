import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, dirname, join as pathJoin, resolve as pathResolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  listTree,
  readFileSafely,
  getDiff,
  getStatus,
  commitPush,
  rememberNote,
  probeBaton,
} from "./api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = pathResolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT ?? 4321);
const BIND = process.env.BIND ?? "127.0.0.1";
const TOKEN = process.env.BATON_WEB_TOKEN;
const SHELL =
  process.env.BATON_WEB_SHELL ?? process.env.SHELL ?? "/bin/zsh";
const STARTING_DIR = process.env.BATON_WEB_CWD ?? homedir();
// Project root for the file/diff API. Defaults to the shell's starting
// dir; the panel won't track `cd` inside the terminal until v0.3.
const PROJECT_ROOT = pathResolve(
  process.env.BATON_WEB_PROJECT ?? STARTING_DIR
);
// Path to the baton CLI for the optional /api/remember endpoint. May
// include args (e.g. "node /home/dev/baton/dist/cli/index.js"). When
// unset, the "save to memory" button stays hidden in the UI.
const BATON_BIN = process.env.BATON_BIN ?? "";

if (!TOKEN) {
  console.error(
    "[baton-web] FATAL: set BATON_WEB_TOKEN to a long random string before starting the server."
  );
  console.error(
    "[baton-web] Example: BATON_WEB_TOKEN=$(openssl rand -hex 32) baton-web"
  );
  process.exit(1);
}

if (TOKEN.length < 20) {
  console.error(
    "[baton-web] FATAL: BATON_WEB_TOKEN is too short. Use at least 20 characters of entropy."
  );
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function checkApiAuth(req: http.IncomingMessage, url: URL): boolean {
  // Accept token via Authorization: Bearer <token> (preferred) or
  // ?token=... (fallback for fetch-without-headers in the browser).
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === TOKEN;
  }
  return url.searchParams.get("token") === TOKEN;
}

async function handleApi(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!checkApiAuth(req, url)) {
    unauthorized(res);
    return;
  }
  try {
    if (url.pathname === "/api/status") {
      const status = await getStatus(PROJECT_ROOT);
      sendJson(res, 200, { status });
      return;
    }
    if (url.pathname === "/api/tree") {
      const tree = await listTree(PROJECT_ROOT);
      sendJson(res, 200, { tree });
      return;
    }
    if (url.pathname === "/api/file") {
      const path = url.searchParams.get("path") ?? "";
      if (!path) {
        sendJson(res, 400, { error: "path required" });
        return;
      }
      const r = await readFileSafely(PROJECT_ROOT, path);
      sendJson(res, 200, r);
      return;
    }
    if (url.pathname === "/api/diff") {
      const path = url.searchParams.get("path") ?? "";
      if (!path) {
        sendJson(res, 400, { error: "path required" });
        return;
      }
      const r = await getDiff(PROJECT_ROOT, path);
      sendJson(res, 200, r);
      return;
    }
    if (url.pathname === "/api/commit-push") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      const message = typeof body?.message === "string" ? body.message : "";
      if (!message.trim()) {
        sendJson(res, 400, { error: "message required" });
        return;
      }
      const result = await commitPush(PROJECT_ROOT, message);
      sendJson(res, result.ok ? 200 : 200, result);
      return;
    }
    if (url.pathname === "/api/baton-status") {
      const available = BATON_BIN
        ? await probeBaton(BATON_BIN)
        : false;
      sendJson(res, 200, { available, configured: BATON_BIN.length > 0 });
      return;
    }
    if (url.pathname === "/api/remember") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!BATON_BIN) {
        sendJson(res, 503, {
          error: "baton integration not configured (set BATON_BIN env var)",
        });
        return;
      }
      const body = await readJsonBody(req);
      const text = typeof body?.text === "string" ? body.text : "";
      if (!text.trim()) {
        sendJson(res, 400, { error: "text required" });
        return;
      }
      const tags = Array.isArray(body?.tags)
        ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      const project =
        typeof body?.project === "string" ? (body.project as string) : null;
      const result = await rememberNote(BATON_BIN, text, {
        tags: tags.length ? tags : undefined,
        project: project,
      });
      sendJson(res, result.ok ? 200 : 200, result);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    const msg = (err as Error).message ?? "internal";
    const status = msg === "path-traversal" ? 403 : 500;
    sendJson(res, status, { error: msg });
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(
  req: http.IncomingMessage,
  capBytes = 1024 * 1024
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > capBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  if (total === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(url, req, res);
    return;
  }

  let path = url.pathname === "/" ? "/index.html" : url.pathname;

  // Prevent path traversal: resolve absolute paths and require the
  // result to live inside PUBLIC_DIR (with the trailing separator so a
  // sibling directory like /public-sneaky/ can't masquerade).
  const filePath = pathResolve(PUBLIC_DIR, "." + path);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const buf = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": "no-cache",
    });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/term") {
    socket.destroy();
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket) => {
  console.log("[baton-web] new terminal session");
  // Spawn a login shell so PATH and aliases load the same way they do in
  // a normal terminal. cwd defaults to home unless overridden via env.
  const pty: IPty = ptySpawn(SHELL, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: STARTING_DIR,
    env: process.env as Record<string, string>,
  });

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[baton-web] shell exited (${exitCode})\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      // Treat non-JSON frames as raw input bytes.
      pty.write(String(raw));
      return;
    }
    switch (msg.type) {
      case "input":
        if (typeof msg.data === "string") pty.write(msg.data);
        break;
      case "resize":
        if (
          typeof msg.cols === "number" &&
          typeof msg.rows === "number" &&
          msg.cols > 0 &&
          msg.rows > 0
        ) {
          pty.resize(msg.cols, msg.rows);
        }
        break;
    }
  });

  ws.on("close", () => {
    pty.kill();
    console.log("[baton-web] session closed");
  });
});

httpServer.listen(PORT, BIND, () => {
  console.log(`[baton-web] listening on http://${BIND}:${PORT}`);
  console.log(`[baton-web] shell:   ${SHELL}`);
  console.log(`[baton-web] cwd:     ${STARTING_DIR}`);
  console.log(`[baton-web] project: ${PROJECT_ROOT}`);
  if (BATON_BIN) {
    console.log(`[baton-web] baton:   ${BATON_BIN}`);
  } else {
    console.log(`[baton-web] baton:   (set BATON_BIN to enable memory save)`);
  }
});


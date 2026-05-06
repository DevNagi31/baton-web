import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, dirname, join as pathJoin, resolve as pathResolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = pathResolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT ?? 4321);
const BIND = process.env.BIND ?? "127.0.0.1";
const TOKEN = process.env.BATON_WEB_TOKEN;
const SHELL =
  process.env.BATON_WEB_SHELL ?? process.env.SHELL ?? "/bin/zsh";
const STARTING_DIR = process.env.BATON_WEB_CWD ?? homedir();

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

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
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
  console.log(`[baton-web] shell: ${SHELL}`);
  console.log(`[baton-web] cwd:   ${STARTING_DIR}`);
});


# baton-web

Vibe-code from your phone. A self-hosted web terminal that lets you run
Claude Code, Codex, or Cursor — the real CLIs, the same way you'd use
them in your laptop's terminal — through a browser tab on any device.

You ssh-style into your dev environment, except instead of ssh you open
a URL on your phone, and instead of typing in a phone shell you talk to
an AI agent that does the typing for you.

Sister project to [baton](https://github.com/DevNagi31/baton). baton-web
shells the same CLIs that baton orchestrates, so they share memory and
config naturally.

> Working name. May be renamed before v0.1.

---

## What it actually is

A small Node server you run on your laptop (or a $5/mo VPS), wrapped in
a mobile-friendly web terminal. The server spawns a real PTY, attaches
the user's interactive shell, and pipes the bytes over a WebSocket to
xterm.js running in the browser. Anything you can do in your local
terminal — `claude -p "build me a /health endpoint"`, `codex exec ...`,
`agent --print ...` — works the same way through the page.

Crucially, the file changes happen on the *server*'s file system, not
your phone's. You see them live in a side panel; you push them to git
when you're ready.

## What it deliberately is not

- **Not a Replit competitor.** It's single-tenant by design. You run
  one instance for yourself.
- **Not a cloud sandbox.** The server runs in a directory you control.
  No per-user containers, no orchestrator, no multi-tenant infra.
- **Not an IDE.** The browser surface is a terminal + minimal file
  diff. If you want a full editor, pair this with VS Code Web or just
  let the agent write the code.

## Architecture

```
your phone (browser)
       │ HTTPS or Tailscale-private
       ▼
┌──────────────────────────┐
│ baton-web server (Node)  │
│  ┌────────────────────┐  │
│  │ ws + node-pty      │──┼──→ /bin/zsh -l (or your $SHELL)
│  └────────────────────┘  │       │
│  ┌────────────────────┐  │       └─→ claude / codex / agent
│  │ static: xterm.js   │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

The server has two responsibilities:

1. Serve the static page (`public/index.html`) with xterm.js
2. Hold a WebSocket per session that is wired to a node-pty child
   process running your shell. Bytes flow both ways. The terminal
   resize protocol propagates so the agent sees your phone's actual
   columns.

Auth is a single shared bearer token, set via `BATON_WEB_TOKEN` env
var, sent as a query param when the WebSocket opens. Good enough for
single-tenant; bad for shared use.

## Roadmap (small)

- **v0.1** — single-user, password auth, raw terminal ✅ shipped
  - [x] Node + ws + node-pty + xterm.js skeleton
  - [x] Mobile-friendly viewport (CSS, soft keyboard sizing)
  - [x] Bearer-token auth via `BATON_WEB_TOKEN`
  - [ ] Survives connection drops (reattach to existing PTY) — deferred
- **v0.2** — file tree + diff panel ✅ shipped
  - [x] Slide-in side panel reachable from a header button
  - [x] File list with status badges (M/A/D/R/?) for changed files
  - [x] Diff view showing `git diff HEAD` per file
  - [x] Untracked files synthesize an "all additions" diff
  - [x] `/api/status`, `/api/tree`, `/api/file`, `/api/diff` HTTP
        endpoints under the same bearer-token auth
  - [x] Path-traversal protected on every endpoint
  - [x] Auto-poll status every 4s; tree refreshes when panel is open;
        the header "files" button shows a dot when anything is dirty
  - [ ] Voice input (mobile mic → speech-to-text → terminal stdin) —
        deferred to v0.3
  - [ ] One-click "git commit and push" — deferred to v0.3
- **v0.3** — deploy story + nice-to-haves ✅ shipped
  - [x] Voice input via Web Speech API → compose textarea → terminal
  - [x] Commit & push button (POST /api/commit-push, surfaces each
        step's exit code and output; gracefully reports "nothing to
        commit" without looking broken)
  - [x] Tailscale Funnel + Cloudflare Tunnel deploy guide
        (see [DEPLOY.md](./DEPLOY.md))
  - [ ] Dockerfile + docker-compose — deferred. The CLIs need their
        own auth state (`~/.claude`, `~/.codex`, `~/.cursor`) so
        containerizing them well is its own project. Run on bare Node
        for now, see DEPLOY.md.
- **v0.4** — baton integration ✅ shipped
  - [x] Side-panel button "save to memory" backed by `POST /api/remember`
        which shells to `BATON_BIN remember` (button hidden when
        BATON_BIN is unset or not invokable)
  - [x] `/api/baton-status` reports configured/available so the UI can
        show or hide the button without flicker
  - [x] [MCP.md](./MCP.md) explains how to wire baton-memory's MCP
        server into Claude Code / Codex / Cursor so agents read & write
        the same semantic memory across sessions. Auto-config of those
        files is deliberately not done — copy-pasting is the right
        boundary so baton-web isn't silently editing user dotfiles.

## Why ~/.baton-web/ instead of a per-project dir

Unlike baton, this tool isn't tied to a specific project. The server
runs from one directory (typically your laptop's home, or a workspace
dir on the VPS) and you `cd` to whatever project you're working on
within the terminal session. No per-project initialization needed.

## Cost

| Setup | Cost |
|---|---|
| Run on your laptop, expose via Tailscale (private) | $0 |
| Run on a Hetzner CX11 VPS, expose via Tailscale Funnel | ~$5/mo |
| Run on Fly.io free tier | $0 (with cold-start friction) |

Anthropic / OpenAI / Cursor inference still uses your existing
subscriptions or API keys; baton-web doesn't front any LLM cost.

## Status

Pre-alpha. Repo just initialized. No code yet beyond skeleton.

## License

MIT.

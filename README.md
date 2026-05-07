# baton-web

A web terminal you self-host on your own machine so you can keep coding
when you're away from your laptop. Open the URL on your phone, paste
your token, and you're in a real shell — `claude -p "..."`,
`codex exec "..."`, `agent --print "..."` all work the same way they
do in your normal terminal. File changes happen on your computer; you
see them in a side panel; you commit and push from a button.

It's built for one person: you. Nothing in it is designed to be shared
with strangers.

> Sister project to [baton](https://github.com/DevNagi31/baton). Optional
> integration: a "save to memory" button stores notes in baton's
> persistent memory store, and the included MCP guide shows how to wire
> baton's memory server into your AI CLIs so agents share semantic
> memory across sessions.

## Demo

_TODO: a 60-second screen recording goes here. Add the GIF or MP4 to
`/docs/demo/` and link from this section once recorded._

## Who this is for

You, specifically. If you:

- Already pay for one or more of Claude Pro / ChatGPT / Cursor
- Already have a laptop where those CLIs are installed and authenticated
- Want to be able to push small coding tasks forward when you're on a
  train, in bed, or otherwise away from that laptop

Then baton-web turns your laptop into "the box" and your phone into "the
keyboard." If any of those three things isn't true, the cloud-sandbox
products (Replit, Codespaces, Cursor mobile) probably fit your need
better.

## What it does

A small Node server you run on your laptop. The server:

1. Serves a single-page web UI with an xterm.js terminal
2. Spawns a real PTY attached to your `$SHELL` and pipes the bytes over
   a WebSocket to that page
3. Exposes a small JSON API for the file tree, diffs, git status, and a
   one-button commit-and-push flow
4. Optionally talks to baton's memory CLI so you can drop checkpoint
   notes from the panel header

Anything you can do in your laptop's terminal works the same way through
the page. The agents see whatever cwd / files / credentials your laptop
has.

## What it deliberately is not

- **Not multi-tenant.** It's single-user by design. There's one bearer
  token, one shell, one project root. Sharing your token is sharing
  shell access to your machine.
- **Not a Replit competitor.** I'm not building per-user containers,
  not running code in the cloud, not handling user accounts.
- **Not an IDE.** It's a terminal plus a small file/diff viewer. If you
  want a real editor, pair it with `code .` from inside the terminal.

## Installing

Requires Node 22+ and git. The CLIs you want to use (`claude`, `codex`,
`agent`) should already be installed and authenticated on the host.

```sh
git clone https://github.com/DevNagi31/baton-web
cd baton-web
npm install
npm run build

# pick a project to expose, generate a token, run:
BATON_WEB_TOKEN="$(openssl rand -hex 32)" \
BATON_WEB_PROJECT="$HOME/code/some-project" \
  npm start
```

The server listens on `127.0.0.1:4321` by default. Open it in your
browser, paste the token, you're in.

For phone access, the recommended setup is **Tailscale** (free, private,
no public exposure): install Tailscale on your laptop and your phone,
log in to the same account, then `BIND=0.0.0.0 npm start` and visit
`http://<your-laptop-tailnet-name>:4321/` from the phone. Other deploy
options including Tailscale Funnel and Cloudflare Tunnel are documented
in [DEPLOY.md](./DEPLOY.md).

## Configuration

Set via environment variables when starting the server.

| Variable | What it does | Default |
|---|---|---|
| `BATON_WEB_TOKEN` | Bearer token clients must present | required |
| `PORT` | HTTP/WS port | `4321` |
| `BIND` | Interface to listen on | `127.0.0.1` |
| `BATON_WEB_SHELL` | Shell to spawn | `$SHELL` or `/bin/zsh` |
| `BATON_WEB_CWD` | Where the terminal session starts | `$HOME` |
| `BATON_WEB_PROJECT` | Project root the file/diff panel inspects | same as `BATON_WEB_CWD` |
| `BATON_BIN` | Path to the `baton` CLI for the optional memory button | unset (button hidden) |

## Status

Shipped and stable for personal use. v0.1 → v0.4 of the original roadmap
are all done:

- v0.1 — browser terminal + bearer-token auth
- v0.2 — file tree + diff side panel
- v0.3 — voice input, commit & push, deploy guide
- v0.4 — optional integration with baton's memory store + MCP guide

I use it. It works. The polish that's left is documentation and a demo
video, not engineering. See [CHANGELOG.md](./CHANGELOG.md) for the full
shipping history.

## Future ideas (not promised)

These are speculative. I'm not committing to building them. They're
listed because they came up while building and are worth thinking about
if the personal use case ever expands:

- **Reattach** — survive WebSocket disconnects without dropping the PTY
- **Mac/Windows installer** — Tauri or Homebrew tap so non-technical
  users can install with one click
- **Relay + agent split** — let one publicly-hosted relay broker
  connections to many people's laptop agents, each isolated to their
  own machine. Fundamentally a different product (would compete with
  ngrok/Tailscale); only worth pursuing if there's an audience.

If you want any of these and have a real use case, open an issue.

## Cost

Zero, in practice. Runs on your laptop or a $5 Hetzner box. AI inference
uses your existing subscriptions; baton-web doesn't proxy or charge for
inference.

## Hard limits worth knowing

- The token gates access; sharing it is the same as sharing shell access
- The web terminal can run anything your shell can — including
  destructive commands. `--unattended`-mode AI runs are the equivalent
  of telling the agent "you have full edit power"
- Voice input requires Chrome or Safari; Firefox doesn't ship Web Speech
- iOS Safari requires HTTPS or `localhost` for mic permissions

## Security model

Single user, single token, server runs in the user's account, no
network exposure beyond what the user sets up. The threat model is "a
careful user running this on their own machine" — not "an attacker
who has the token." If the token leaks, rotate it and restart.

## License

MIT.

# Deploying baton-web

baton-web is single-tenant by design — you run one instance for yourself.
The deploy story matches: pick whichever of these costs the least in
your situation, point your phone at it, and go.

> Skip Docker for now. The CLIs (claude / codex / agent) need their own
> auth state per user, so containerizing them well is its own project
> (volume mounts for `~/.claude`, `~/.codex`, `~/.cursor`, plus an
> in-container login flow). Until that's worth doing, run on bare
> Node — your laptop or a small VPS.

## Option A: laptop + Tailscale (free, easiest)

You already have a laptop that can run `claude`, `codex`, and `agent`.
Tailscale gives every machine in your tailnet a private hostname, so
your phone can reach your laptop without exposing anything to the public
internet.

1. Install Tailscale on your laptop and your phone, and log in to the
   same account on both. https://tailscale.com (free tier: 100 devices).
2. From the laptop, find your tailnet hostname:
   ```sh
   tailscale status --json | jq -r '.Self.HostName'
   # → e.g. "macbook-air"
   ```
3. Start baton-web bound to all interfaces:
   ```sh
   cd ~/Desktop/baton-web
   BATON_WEB_TOKEN="$(openssl rand -hex 32)" \
   BIND=0.0.0.0 \
   BATON_WEB_PROJECT="$HOME/code/some-project" \
     npm run dev
   ```
4. On your phone, open `http://<tailnet-hostname>:4321/` and paste
   the token. Done.

Pros: $0, no public exposure, full speed of your laptop.
Cons: laptop has to be on. Token travels in plaintext over the tailnet
(which is encrypted end-to-end at the network layer, so this is fine in
practice).

## Option B: small VPS + Tailscale Funnel (~$5/mo, public HTTPS)

If your laptop sleeps or you want a stable URL you can demo to anyone:

1. Get a Hetzner CX11 or comparable ($5/mo, plenty for this).
2. ssh in. Install Node 22 (`fnm` or NodeSource), git, and the CLIs you
   want available (`claude`, `codex`, `agent` via their official
   installers). Log into each one.
3. Clone baton-web and `npm install && npm run build`.
4. Create a dedicated unprivileged user that owns your project repos
   (`adduser ai`). Don't run baton-web as root.
5. Install Tailscale on the VPS. Enable [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
   to get a free public HTTPS URL pointed at your service:
   ```sh
   sudo tailscale funnel --bg --https=4321 4321
   # outputs: https://<hostname>.<tailnet>.ts.net/
   ```
6. Run baton-web behind the funnel. Bind to localhost only — Funnel
   handles the public TLS terminator:
   ```sh
   sudo systemctl --user start baton-web
   # or run it under tmux / pm2 / a systemd user unit
   ```
7. Open the Tailscale Funnel URL on your phone, log in with your token.

Pros: stable HTTPS, share-able URL, can demo to others.
Cons: paying $5/mo, costs scale if you go heavy on disk/CPU, you have
to do basic VPS hygiene (firewall, unattended-upgrades).

## Option C: laptop + Cloudflare Tunnel (free, public HTTPS)

Same shape as Option B but the service runs on your laptop and
Cloudflare Tunnel exposes it publicly via your domain. Useful if you
have a domain on Cloudflare already.

1. Install `cloudflared` and authenticate.
2. Create a tunnel pointed at `localhost:4321`:
   ```sh
   cloudflared tunnel create baton-web
   cloudflared tunnel route dns baton-web baton.your-domain.com
   cloudflared tunnel run baton-web
   ```
3. Run baton-web on the laptop (BIND=127.0.0.1 is fine; the tunnel
   talks to localhost):
   ```sh
   BATON_WEB_TOKEN="$(openssl rand -hex 32)" \
   BATON_WEB_PROJECT="$HOME/code/foo" \
     npm run dev
   ```
4. Open `https://baton.your-domain.com/` on your phone.

Same trade-off as A but with a public URL.

## Hardening checklist (any option)

- [ ] `BATON_WEB_TOKEN` is generated with `openssl rand -hex 32` and
      stored in a password manager. **Don't reuse it across deploys.**
- [ ] If you expose to the public internet (Option B/C), assume any
      visitor with the token can run arbitrary shell commands. Use a
      different token per device if you can stomach the inconvenience.
- [ ] `BATON_WEB_PROJECT` is the project root the panel inspects. Pick
      one project — don't point it at `$HOME` unless you're OK with
      the file API listing every dotfile you have.
- [ ] The host's git credentials (or an ssh key with push access) are
      the credentials baton-web's commit & push button uses. Audit
      what those keys can write to.
- [ ] If you ever want to give somebody else access, run a separate
      baton-web instance for them with its own token and its own
      project root. Do not share tokens across people.

## Logs and process management

baton-web prints to stderr by default. For long-running setups, wrap
it in a process manager:

- **systemd user unit**: drop `baton-web.service` in `~/.config/systemd/user/`
  with `ExecStart=npm start` and `WorkingDirectory=` your install path.
- **tmux**: just `tmux new -s baton-web 'cd ~/baton-web && npm start'`
  and detach — most "personal use" deployments don't need anything
  fancier.
- **pm2**: `pm2 start dist/server.js --name baton-web`.

## Updating

```sh
cd ~/baton-web
git pull
npm install
npm run build
# restart whatever process supervisor you chose
```

## Uninstalling

There's no persistent state baton-web owns beyond the optional
sessionStorage on the client. To remove cleanly:

```sh
rm -rf ~/baton-web
# unset any environment variables you set (BATON_WEB_TOKEN, etc.)
# stop the systemd unit / tmux session / pm2 process if you set one up
```

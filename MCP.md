# Wiring baton-memory into your AI CLI

baton-web's "save to memory" button gives you a manual way to drop notes
into baton's persistent memory. But agents inside your terminal session
can also read and write that memory directly through MCP — meaning you
won't have to re-explain context to Claude / Codex / Cursor every time
you start a new session.

This doc shows how to wire baton-memory into each CLI. baton-web does
**not** edit these config files for you; that would be invasive and
brittle across CLI versions. Copy-paste the snippets below.

## Prerequisite

Have [baton](https://github.com/DevNagi31/baton) installed where the
agent will run. baton-web's host is fine. Test it:

```sh
baton --version
# or, if not on PATH:
node /path/to/baton/dist/cli/index.js --version
```

baton's MCP server starts with:

```sh
baton mcp
# stdout is the protocol channel; stderr logs:
# [baton mcp] starting memory server at /Users/you/.baton
```

## Claude Code

Add to `~/.claude/mcp.json` (or `<project>/.claude/mcp.json` to scope to
one repo):

```json
{
  "mcpServers": {
    "baton-memory": {
      "command": "baton",
      "args": ["mcp"]
    }
  }
}
```

Or as a one-shot for a single Claude run, add `--mcp-config`:

```sh
claude -p "do thing" --mcp-config '{"mcpServers":{"baton-memory":{"command":"baton","args":["mcp"]}}}'
```

Claude will now see `add_memory`, `search_memory`, `list_memories`, and
`delete_memory` as available tools and call them when relevant.

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.baton-memory]
command = "baton"
args = ["mcp"]
```

Or use `codex mcp add` interactively:

```sh
codex mcp add baton-memory baton mcp
```

Codex will list `baton-memory` under available MCP servers in its
session header.

## Cursor agent

Add to `~/.cursor/mcp.json` (or `<workspace>/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "baton-memory": {
      "command": "baton",
      "args": ["mcp"]
    }
  }
}
```

Cursor's `agent --print` mode picks this up automatically. For
interactive Cursor IDE, restart the editor after adding.

## Verifying it works

Open a session and ask the agent to recall something:

> What was the last thing I was working on in this project?

If MCP is wired up, the agent will call `search_memory` and surface the
relevant entries from `~/.baton/memory.db`. You should see the call in
the agent's tool-use output.

## Why baton-web shows the "save to memory" button

Even with MCP wired in, the agent only saves memories when *it* decides
something is worth remembering. The "save to memory" button in
baton-web's panel is for the moments where *you* want to drop a
checkpoint — a decision you just made, a bug you just fixed, a place
you're stopping for the day — without needing to convince the agent
to record it.

## Why baton-web does not edit these files

These configs live under your home directory and have implications for
every CLI invocation, not just baton-web's session. Editing them
silently would be a real footgun if your existing config breaks or
gets overwritten. Copy-pasting once is the right boundary.

# agenttoolbox-agent

Local agent bridge for [AgentToolbox](https://dengzhh.github.io/agent-site/).

Run:

    npx agenttoolbox-agent@latest

Starts a loopback-only (127.0.0.1:31415) HTTP service that powers the Chat
drawer on the free-models page. Bring your own API keys — they stay in
memory and are sent only to the model provider you choose.

- `GET /health` — liveness + version, adapter availability, granted directories
- `POST /sessions` — `{provider, model, baseUrl?, apiKey?, envKey?, name?, contextWindow?, maxOutput?, agents?, agent?, cwd?, toolTier?}`
  → `{sessionId, adapter, provider, model, cwd, toolTier}` (`agents` is the adapter preference
  order, e.g. `["cc","pi"]`; default `["pi"]`. `agent` targets one adapter
  directly — including a specific ACP agent via `agent: "acp:<id>"`.
  `cwd` is an optional working directory — it must exist and be a directory,
  or the session is rejected with `400 {error: "invalid cwd"}`. `toolTier`
  selects the tool set — see [Work directory & tool tiers](#work-directory--tool-tiers))
- `POST /sessions/:id/messages` — `{text}` → SSE stream (`delta`/`thinking`/`usage`/`activity`/`turn_end`/`error`/`done`)
- `POST /sessions/:id/abort`
- `POST /quota/openrouter` — `{apiKey}` → `{usage, limit, isFreeTier, rateLimit}`.
  Proxies OpenRouter's `/api/v1/key` account lookup so the page can show
  free-tier quota. `400` without a key; the key is forwarded only to OpenRouter
  and never logged. Upstream failures mirror the upstream status code with a
  generic message — no response fragments leak through

Options: `--port <n>` / `PORT` env (default 31415); `AGENT_ALLOWED_ORIGINS`
(comma-separated extra CORS origins, e.g. `http://localhost:4321` for dev).

## Adapters

A session is served by the first *available* adapter in the preference order you
pass as `agents`. Two adapters ship today:

- **`pi`** — in-process runtime (pi-agent-core). This is the default and has no
  extra prerequisites beyond Node; it talks to the provider directly with your key.
- **`cc`** — spawns the `claude` CLI headless (`claude -p --output-format=stream-json`)
  and streams its events back. It requires **Claude Code to be installed** and on
  `PATH`. Use it for models that are only served behind an agentic harness — e.g.
  OpenRouter's gated `:free` models, which reject plain API clients.

The `cc` adapter runs the CLI against a throwaway `CLAUDE_CONFIG_DIR` (a fresh
temp directory per turn), so it never loads or mutates your own
`~/.claude/settings.json` — your personal model, hooks, and plugins stay out of
the session.

### `acp` — one adapter, five more agents

The `acp` adapter speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(JSON-RPC over stdio, official Node SDK) and exposes five coding agents:

| id (`agent: "acp:<id>"`) | launched as | config isolation |
|---|---|---|
| `acp:hermes` | `hermes acp` | `HERMES_HOME` |
| `acp:openclaw` | `openclaw acp` | `OPENCLAW_HOME` — **requires the OpenClaw Gateway to be running** |
| `acp:opencode` | `opencode acp` | `OPENCODE_CONFIG_DIR` (+ `OPENCODE_DISABLE_CLAUDE_CODE=1`) |
| `acp:codex` | `npx -y @zed-industries/codex-acp` | `CODEX_HOME` |
| `acp:dsh` | `npx -y @deepseek-ai/dsh --profile acp` | `DSH_HOME` |

Each is listed in `/health` as `acp:<id>` with a live `available` probe — the
chat UI only offers agents it can actually run. Verified working: hermes
(full turn), codex (handshake). openclaw needs its Gateway; opencode and dsh
follow the same path once installed. ACP sessions are throwaway-configured too
(each spawn gets a fresh config home), and permission requests are answered
heuristically for headless use — read-only-looking calls pass in `read` tier,
everything else is denied (see
[Work directory & tool tiers](#work-directory--tool-tiers)); the security
boundary remains the session `cwd` and the directory-grant mechanism.

## Work directory & tool tiers

Sessions are **chat-only by default**. Two optional `POST /sessions` fields
unlock file access, both scoped to a single session:

- `cwd` — a path on the machine running the gateway. It is validated at session
  creation (must exist and be a directory, else `400 invalid cwd`) and becomes
  the working directory / path boundary for every tool the agent gets.
- `toolTier` — `'none'` (default) or `'read'`. `'full'` additionally attaches
  the write/execute tools for `pi` (`write_file`/`bash`, each gated by an
  approval drawer); anything unrecognized falls back to `'none'`, so a typo
  can never escalate privileges. Note that `bash` runs with the gateway's own
  environment (`-lc` also sources login profiles), so approved commands can
  read the gateway process's environment variables.

What `read` means per adapter:

- **`pi`** — attaches three read-only tools (`read_file`/`list_dir`/`grep`),
  built fresh each turn and closed over the session `cwd`. Every path is
  resolved and realpath-checked to land inside `cwd` (blocking `../` traversal
  and symlink escapes); `grep` skips dependency/hidden directories, caps single
  files at 1 MB and returns at most 50 matches. `read` **without** a `cwd`
  attaches no tools at all — no hard boundary, no tools.
- **`cc`** — spawns the CLI with `--allowedTools Read,Grep,Glob` and the working
  directory set (a previously granted directory takes precedence over the
  session `cwd`; see [Directory grants](#directory-grants)). What the CLI may do
  with those tools is governed by Claude Code's own permission layer.
- **`acp`** — the sub-agent's session is created with the given `cwd`, and
  `session/request_permission` calls are answered heuristically for headless
  use: in `read` tier, tool calls whose title/kind looks read-only
  (read/view/grep/glob/search/list/find/inspect/ls) are allowed once; write,
  execute, and unknown calls are rejected — as is everything in `none` tier.

`none` is pure chat: no tools are attached and behavior is unchanged from
earlier releases.

## SSE events

`POST /sessions/:id/messages` streams these SSE kinds:

- `delta` `{text}` — assistant text (streamed)
- `thinking` `{text}` — reasoning chain (render it muted/italic; it arrives before the answer)
- `usage` `{usage:{used,size,cost?}}` — context-window accounting (ACP agents)
- `activity` `{title}` — a tool call started (e.g. "Read file")
- `turn_end` `{stopReason}` — the turn finished (`end_turn`, or `error` on failure)
- `error` `{message}` — something failed (bad key, gated model, adapter error)
- `done` — always the final frame; the stream closes after it

## Directory grants

The `cc` adapter is **chat-only by default**: with no granted directories and no
session `cwd` it is given no tools at all. Since 0.4.0 a session can unlock its
read-only tools (`Read`/`Grep`/`Glob`) per-session via the `cwd`/`toolTier`
fields (see [Work directory & tool tiers](#work-directory--tool-tiers));
persistent grants remain the alternative, and a granted directory takes
precedence over the session `cwd` for `cc`.

Browser pages cannot hand a local service a trusted filesystem path, so
persistent grants are terminal-only:

    npx agenttoolbox-agent grant <dir>    # authorize a directory
    npx agenttoolbox-agent list           # show granted directories
    npx agenttoolbox-agent revoke <dir>   # withdraw a grant

Grants persist in `~/.config/agenttoolbox/config.json`. Point
`ATBX_CONFIG_PATH` at a different file to override that location (used by tests
and by the CLI subcommands).

## HTTP responses

`GET /health` returns the service version, adapter availability, and the
current grant list:

```json
{
  "ok": true,
  "version": "0.4.0",
  "agents": [
    { "id": "pi", "available": true },
    { "id": "cc", "available": false },
    { "id": "acp:hermes", "name": "Hermes", "available": true },
    { "id": "acp:codex", "name": "Codex", "available": false }
  ],
  "grantedDirs": ["/home/you/project"]
}
```

`agents[].available` is a live probe (for `cc`, whether the `claude` binary is
found; for `acp:<id>`, whether that agent's CLI resolves). `name` is a display
label for ACP sub-agents.

Node >= 22.12. MIT.

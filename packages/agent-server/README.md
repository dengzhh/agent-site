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
- `POST /sessions/:id/messages` — `{text}` → SSE stream (`delta`/`thinking`/`usage`/`activity`/`permission_request`/`turn_end`/`error`/`done`)
- `POST /sessions/:id/permission` — answers a pending `permission_request`:
  `{reqId, decision: "allow"}` (any other `decision` counts as a denial) →
  `200 {ok: true}`. Unknown session or unknown/already-settled `reqId` → `404`
  (replays are treated as never having existed)
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
(each spawn gets a fresh config home), and permission requests are answered for
headless use — heuristically in `read` tier (read-only-looking calls pass,
everything else is denied) and via the approval drawer in `full` tier (see
[Work directory & tool tiers](#work-directory--tool-tiers)); the security
boundary remains the session `cwd` and the directory-grant mechanism.

## Work directory & tool tiers

Sessions are **chat-only by default**. Two optional `POST /sessions` fields
unlock file access, both scoped to a single session:

- `cwd` — a path on the machine running the gateway. It is validated at session
  creation (must exist and be a directory, else `400 invalid cwd`) and becomes
  the working directory / path boundary for every tool the agent gets.
- `toolTier` — `'none'` (default), `'read'`, or `'full'`. Anything unrecognized
  falls back to `'none'`, so a typo can never escalate privileges. `'full'`
  additionally unlocks the write/execute capabilities per adapter (see below),
  with every gated call approved through the drawer first
  ([Permission flow](#permission-flow)). Note that `bash` runs with the gateway's
  own environment (`-lc` also sources login profiles), so approved commands can
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
  (read/view/grep/glob/search/list/find/inspect/ls) are allowed — answered with
  the request's own allow-once option, or `cancelled` when the offered options
  don't contain exactly one; write, execute, and unknown calls are rejected —
  as is everything in `none` tier.

What `full` means per adapter:

- **`pi`** — attaches the read-only three plus `write_file` and `bash`, again
  only when a session `cwd` is set (no boundary, no tools). Every
  `write_file`/`bash` call is gated by an approval before it acts; a denial
  returns an error tool result (`denied by user`) and nothing is written or
  executed. `write_file` creates or overwrites a text file up to 1 MB inside
  `cwd`; the target is resolved and realpath-checked, symlinks are never
  followed out of `cwd`, and parent directories must already exist (no
  `mkdir -p`). `bash` runs `bash -lc <command>` inside `cwd` as a detached
  process group with a 60s timeout (the whole group is killed) and merged
  stdout+stderr truncated to 8 KB; a non-zero exit code is reported as
  ordinary output, not a tool error.
- **`cc`** — the CLI is spawned with `--input-format stream-json
  --permission-prompt-tool stdio`, turning the pipe into a bidirectional
  control channel: every tool use the CLI attempts becomes a `can_use_tool`
  round-trip that the gateway forwards to the drawer and answers with allow
  (the call proceeds exactly as asked) or deny (a `denied by user` message
  back to the CLI). A missing or failing approval gate denies the call —
  fail-closed. Stdin is closed as soon as the turn's result line arrives, so
  the turn completes instead of waiting on the channel.
- **`acp`** — `session/request_permission` calls are forwarded to the approval
  drawer, with the action and summary derived from the tool call's
  `kind`/`title`. In `read` tier the drawer is bypassed (the heuristic above
  applies); a missing or failing approval gate rejects the call.

`none` is pure chat: no tools are attached and behavior is unchanged from
earlier releases.

### Permission flow

A gated call pauses the turn: the gateway emits a `permission_request` SSE
event (`{reqId, action, summary}` — e.g. the command text or the file path
about to be written), the chat UI renders an approval card, and the turn
resumes only when you answer via `POST /sessions/:id/permission`. Unanswered
requests are auto-denied after 120 seconds; aborting the turn (or losing the
SSE connection) denies every pending request at once.

Denial is a first-class outcome — the agent is simply told the user refused
(`pi`: error tool result; `cc`: deny message to the CLI; `acp`: rejected
outcome) and can carry on from there. Nothing is ever auto-remembered: the
gateway never selects an "allow and remember" (`*_always`) option, and when an
ACP agent's offered permission options cannot be resolved to exactly one safe
allow-once and one reject-once entry (missing, duplicated, ambiguous, or
"remember"-only lists), the answer is `cancelled` — the agent is told the user
didn't choose, nothing is granted and nothing remembered.

## SSE events

`POST /sessions/:id/messages` streams these SSE kinds:

- `delta` `{text}` — assistant text (streamed)
- `thinking` `{text}` — reasoning chain (render it muted/italic; it arrives before the answer)
- `usage` `{usage:{used,size,cost?}}` — context-window accounting (ACP agents)
- `activity` `{title}` — a tool call started (e.g. "Read file")
- `permission_request` `{reqId, action, summary}` — a gated tool call needs
  approval; the turn pauses until you answer via
  `POST /sessions/:id/permission` (see
  [Permission flow](#permission-flow); unanswered requests auto-deny after 120s)
- `turn_end` `{stopReason}` — the turn finished (`end_turn`, or `error` on failure)
- `error` `{message}` — something failed (bad key, gated model, adapter error)
- `done` — always the final frame; the stream closes after it

## Session history

Conversations are persisted to `~/.config/agenttoolbox/sessions/` so they
survive drawer closes, reloads and gateway restarts (7-day TTL by default;
override with `ATBX_SESSION_TTL_DAYS`). Records are `0600`, the directory
`0700` — transcripts can contain file contents, command output and
screenshots from `full` tier runs. **API keys are never written to disk.**

Website-created sessions are also mirrored into pi CLI's native format
(`ATBX_PI_SESSION_DIR`, default `~/.pi/agent/sessions/`), so you can continue
one locally. Always pass `--session-dir`, and use `--fork` when running from
a different directory than the session's cwd:

    pi --session-dir <ATBX_PI_SESSION_DIR> --fork <piSessionId> "…"

The drawer shows that exact command with a copy button. `cc` sessions resume
locally with `claude --resume <ccSessionId>`. Sessions you start in the
terminal yourself are not listed in the web UI — that direction is one-way.

Terminal management (the web UI can only clear the current directory's scope):

    npx agenttoolbox-agent sessions list           # metadata only, never message text
    npx agenttoolbox-agent sessions clear --yes    # deletes every transcript

## Directory grants

The `cc` adapter is **chat-only by default**: in `none`/`read` tiers, with no
granted directories and no session `cwd`, it is given no tools at all. Since
0.4.0 a session can unlock its read-only tools (`Read`/`Grep`/`Glob`)
per-session via the `cwd`/`toolTier` fields (see
[Work directory & tool tiers](#work-directory--tool-tiers)); persistent grants
remain the alternative, and a granted directory takes precedence over the
session `cwd` for `cc`. `full` tier is deliberately different: the CLI keeps
its native tool set behind the per-action approval drawer, and with no `cwd`
(or grant) it works in the gateway process's own working directory — set
`cwd` explicitly if that is not what you want.

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
  "version": "0.5.2",
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

# agenttoolbox-agent

Local agent bridge for [AgentToolbox](https://dengzhh.github.io/agent-site/).

Run:

    npx agenttoolbox-agent@latest

Starts a loopback-only (127.0.0.1:31415) HTTP service that powers the Chat
drawer on the free-models page. Bring your own API keys — they stay in
memory and are sent only to the model provider you choose.

- `GET /health` — liveness + version, adapter availability, granted directories
- `POST /sessions` — `{provider, model, baseUrl?, apiKey?, envKey?, name?, contextWindow?, maxOutput?, agents?}`
  → `{sessionId, adapter, provider, model}` (`agents` is the adapter preference
  order, e.g. `["cc","pi"]`; default `["pi"]`)
- `POST /sessions/:id/messages` — `{text}` → SSE stream (`delta`/`turn_end`/`error`/`done`)
- `POST /sessions/:id/abort`

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

## Directory grants

The `cc` adapter is **chat-only by default**: with no granted directories it is
given no tools at all. Granting a directory unlocks its read-only tools
(`Read`/`Grep`/`Glob`) and sets it as the working directory for the CLI.

Browser pages cannot hand a local service a filesystem path, so grants are
terminal-only:

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
  "version": "0.2.0",
  "agents": [{ "id": "pi", "available": true }, { "id": "cc", "available": false }],
  "grantedDirs": ["/home/you/project"]
}
```

`agents[].available` is a live probe (for `cc`, whether the `claude` binary is
found).

Node >= 22.12. MIT.

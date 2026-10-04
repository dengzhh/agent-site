# agenttoolbox-agent

Local agent bridge for [AgentToolbox](https://dengzhh.github.io/agent-site/).

Run:

    npx agenttoolbox-agent@latest

Starts a loopback-only (127.0.0.1:31415) HTTP service that powers the Chat
drawer on the free-models page. Bring your own API keys — they stay in
memory and are sent only to the model provider you choose.

- `GET /health` — liveness + version
- `POST /sessions` — `{provider, model, baseUrl?, apiKey?, envKey?, name?, contextWindow?, maxOutput?}`
- `POST /sessions/:id/messages` — `{text}` → SSE stream (`delta`/`turn_end`/`error`/`done`)
- `POST /sessions/:id/abort`

Options: `--port <n>` / `PORT` env (default 31415); `AGENT_ALLOWED_ORIGINS`
(comma-separated extra CORS origins, e.g. `http://localhost:4321` for dev).

Node >= 22.12. MIT.

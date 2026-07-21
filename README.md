# auth2api

Local OAuth-to-API proxy with a **Codex <-> Cursor ACP bridge**: drive Cursor's
agent (Composer, `cursor-agent`) from the OpenAI Codex app/CLI as if it were a
native Responses API model — with persistent tool calls, native steering, and
crash resumability.

Originally derived from [AmazingAng/auth2api](https://github.com/AmazingAng/auth2api);
this repository has since diverged into its own project centered on the ACP bridge.

## What it does

- **Providers**: Anthropic (Claude OAuth), OpenAI Codex (ChatGPT OAuth), Cursor
  (local login). Multi-account pools, refresh, cooldown, stats.
- **Endpoints**: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
  `/v1/models`, `/admin/accounts`, `/admin/stats`, `/health`.
- **Cursor ACP bridge** (`src/upstream/cursor-acp.ts`): translates Codex
  Responses API traffic into ACP (`session/prompt`) against a spawned
  `cursor-agent` process.

## The bridge: tool-boundary chunking

One Cursor turn = N Responses API responses, cut at tool-call boundaries:

1. Codex POSTs `/v1/responses`; proxy starts an ACP `session/prompt`.
2. Text/reasoning stream through as deltas.
3. When Cursor invokes a tool, the proxy closes the response with a
   `function_call` item (`name: cursor_<kind>`, e.g. `cursor_execute`,
   `cursor_edit`; arguments carry title + raw input + locations;
   `call_id: call_cursor_<toolCallId>`).
4. Codex persists the call in history (visible + replayable in the app),
   answers `unsupported call`, and immediately sends a follow-up request.
5. The proxy classifies that follow-up (`continuation` / `steer` / `resume`)
   and keeps streaming the same live turn — nothing is re-sent to Cursor.

Consequences:

- **Persistent tool calls**: every Cursor tool action lands in Codex history.
- **Native steer**: request boundaries are exactly where Codex drains pending
  input, so `turn/steer` from the app arrives as a user message in a follow-up;
  the proxy cancels the ACP prompt and re-prompts the same session.
- **Resumability**: ACP sessions are persisted (`cursor-acp-sessions.json`).
  If the proxy dies mid-turn, Codex's built-in stream retry re-sends the
  request; the proxy classifies it as `resume`, revives the Cursor session
  (`session/resume`), and the turn continues. Requires
  `stream_max_retries > 0` in the Codex provider config.
- **Idle quips**: humorous reasoning filler while Cursor is quiet
  (`src/upstream/cursor-acp-quips.ts`).

Design notes and verified codex-rs facts: [docs/codex-tool-bridge-plan.md](docs/codex-tool-bridge-plan.md).

## Setup

```bash
npm install
npm run build
cp config.example.yaml config.yaml   # edit: enable providers, set transport: acp
node dist/index.js --config=config.yaml
```

Login flows (tokens land in `~/.auth2api/`):

```bash
node dist/index.js login            # Anthropic
node dist/index.js login-codex      # OpenAI Codex
node dist/index.js login-cursor     # Cursor
```

Codex-side provider config (`~/.codex/config.toml`):

```toml
[model_providers.cursor]
name = "cursor"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
stream_max_retries = 5
request_max_retries = 4
```

## Tests

```bash
npm test
```

The ACP bridge suite (`tests/cursor-acp.test.ts`) runs against a fake ACP agent
fixture (`tests/fixtures/fake-cursor-acp.mjs`) and covers boundary chunking,
steer, cancellation, session reuse, and restart persistence.
`scripts/t4-steer-test.mjs` drives a live steer through `codex app-server` v2.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the `apps/remote-server` workspace. See the root `CLAUDE.md` for monorepo-wide guidance. This file covers app-specific details.

## Commands

```bash
# Development
pnpm --filter @pulse-coder/remote-server dev      # Watch mode via tsx
pnpm --filter @pulse-coder/remote-server build    # Compile to dist/index.cjs via tsup

# From this directory
npm run dev
npm run build
npm start                                          # Run dist/index.cjs

# PM2 (production)
npm run pm2:start        # Build + start
npm run pm2:restart      # Rebuild + restart
npm run pm2:logs         # Stream logs
```

No dedicated test suite — this is a runtime app. Manual testing uses `curl` against `/internal/agent/run`.

## Architecture

### Request lifecycle

```
Platform webhook or /internal/agent/run
  → PlatformAdapter.verifyRequest()     # Signature verification
  → PlatformAdapter.parseIncoming()     # → unified IncomingMessage
  → dispatcher.ackRequest()             # Immediate 200/202 (required by Feishu/Telegram)
  → dispatchIncoming() [fire-and-forget]
      → processIncomingCommand()        # Slash command handler
      → executeAgentTurn()              # Engine.run() or ACP agent
      → StreamHandle callbacks → user
```

### Key modules

| File | Role |
|------|------|
| `src/index.ts` | Bootstrap: stores → engine → Discord gateway → HTTP server |
| `src/server.ts` | Hono app factory; mounts all route modules |
| `src/core/dispatcher.ts` | Platform-agnostic webhook handler; concurrency guard via `active-run-store.ts` |
| `src/core/agent-runner.ts` | Builds run context, invokes engine, persists session & memory logs |
| `src/core/session-store.ts` | File-based session store at `~/.pulse-coder/remote-sessions/` |
| `src/core/chat-commands.ts` | Slash command router (`/new`, `/clear`, `/model`, `/wt`, etc.) |
| `src/core/clarification-queue.ts` | Async request/answer pairing for multi-turn clarification |
| `src/core/model-config.ts` | Dynamic LLM model resolution with mtime-based caching |
| `src/routes/internal.ts` | Loopback-only automation API (`/internal/agent/run`) |

### Platform adapters

Each adapter implements four methods: `verifyRequest`, `parseIncoming`, `ackRequest`, `createStreamHandle`. Adapters live in `src/adapters/{feishu,discord,telegram,web}/`.

- **Feishu**: Larksuite SDK, message dedup via LRU cache on `message_id`, card messages with progress state.
- **Discord**: ED25519 signature verification, webhook interactions + Gateway WebSocket for DMs and guild @mentions.
- **Telegram / Web**: implemented but not mounted in `server.ts` by default.

### Integrations

Three plugin-kit integrations wrap engine execution via `runWithAgentContexts()`:

- **Worktree** — git worktree binding state at `~/.pulse-coder/worktree-state/`
- **Workspace** — project identity resolution at `~/.pulse-coder/workspace-state/`
- **Memory** — semantic recall + daily logs via `pulse-coder-memory-plugin` at `~/.pulse-coder/remote-memory/`

### Custom tools (registered in `src/core/engine-singleton.ts`)

`cron_job`, `deferred_demo`, `jina_ai_read`, `twitter_list_tweets`, `session_summary`, `ptc_demo_*`. Some use `defer_loading: true` (discovered only after tool search).

## Configuration

Copy `.env.example` to `.env`. Minimum required variables:

```
OPENAI_API_KEY / ANTHROPIC_API_KEY
OPENAI_MODEL
FEISHU_* or DISCORD_*    # Whichever platform you're using
INTERNAL_API_SECRET       # Required in production
```

Model overrides: `.pulse-coder/config.json` (cwd) or `$PULSE_CODER_MODEL_CONFIG`.

## Coding notes

- Routes are Hono `Context` handlers — keep them thin; delegate to dispatcher or agent-runner.
- Concurrency guard is per `platformKey`; do not bypass `active-run-store` for platform routes.
- Internal routes (`/internal/*`) require loopback IP + Bearer token — enforce both checks when adding new internal endpoints.
- `StreamHandle` callbacks are the only way to send output back to users; adapters own the send logic.

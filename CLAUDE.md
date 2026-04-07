# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pulse Coder is a plugin-first AI coding assistant built as a TypeScript monorepo.

Core capabilities include:
- reusable `Engine` runtime,
- interactive CLI with session/task workflows,
- built-in MCP/skills/plan-mode/task-tracking/sub-agent plugins,
- optional memory integration and remote HTTP runtime.

## Monorepo Structure

This repo uses `pnpm` workspaces (`packages/*`, `apps/*`).

Primary packages:
- `packages/engine` (`pulse-coder-engine`): core engine loop, tools, plugin manager, built-in plugins.
- `packages/cli` (`pulse-coder-cli`): interactive terminal app built on the engine.
- `packages/pulse-sandbox` (`pulse-sandbox`): sandboxed JS executor used by `run_js`.
- `packages/memory-plugin` (`pulse-coder-memory-plugin`): memory service/integration helpers.

Apps:
- `apps/remote-server`: HTTP wrapper around engine runtime.
- `apps/coder-demo`: legacy experimental app.

## Build, Dev, and Test Commands

```bash
pnpm install
pnpm run build
pnpm run dev
pnpm start
pnpm test
pnpm run test:apps
```

Useful filtered commands:

```bash
pnpm --filter pulse-coder-engine test
pnpm --filter pulse-coder-engine typecheck
pnpm --filter pulse-coder-cli test
pnpm --filter pulse-sandbox test
pnpm --filter pulse-coder-memory-plugin test
pnpm --filter @pulse-coder/remote-server build
pnpm --filter @pulse-coder/remote-server dev
```

Notes:
- `pnpm test` runs package tests only (`./packages/*`).
- `pnpm run test:apps` includes app tests and may fail due to placeholder scripts in `apps/coder-demo`.

## Architecture Notes

### Engine bootstrap
`Engine.initialize()` (`packages/engine/src/Engine.ts`) does:
1. plugin manager setup,
2. built-in plugin loading (unless disabled),
3. plugin tool registration,
4. optional custom tool merge (`EngineOptions.tools`, highest priority).

### Execution loop
Core loop is `packages/engine/src/core/loop.ts`.
It supports:
- streaming text/tool events,
- LLM hooks (`beforeLLMCall`, `afterLLMCall`),
- tool hooks (`beforeToolCall`, `afterToolCall`),
- retry/backoff on retryable errors,
- abort handling,
- context compaction.

### Built-in plugins
Registered from `packages/engine/src/built-in/index.ts`:
- MCP plugin (`.pulse-coder/mcp.json`, legacy `.coder/mcp.json`),
- skills plugin (`SKILL.md` scanning + `skill` tool),
- plan-mode plugin,
- task-tracking plugin,
- sub-agent plugin (`.pulse-coder/agents/*.md`).

### Built-in tools
Engine toolset (`packages/engine/src/tools/`):
- `read`, `write`, `edit`, `grep`, `ls`, `bash`, `tavily`, `gemini_pro_image`, `clarify`.

CLI adds:
- `run_js` (from `pulse-sandbox`).

Task tracking adds:
- `task_create`, `task_get`, `task_list`, `task_update`.

### Remote server runtime (`apps/remote-server`)
Entry and server:
- `apps/remote-server/src/index.ts` initializes session store, memory plugin, worktree binding, engine, Discord gateway, then starts the Hono server.
- `apps/remote-server/src/server.ts` mounts `/health`, webhook routes, and `/internal/*` routes (web API routes are present but currently commented out).

Dispatcher and agent execution:
- `apps/remote-server/src/core/dispatcher.ts` verifies/acks webhooks, handles slash commands, prevents concurrent runs per `platformKey`, and streams output via adapter `StreamHandle` callbacks.
- `apps/remote-server/src/core/agent-runner.ts` builds the per-run context, resolves model overrides, runs the engine, persists session state, and records daily memory logs.
- `apps/remote-server/src/core/clarification-queue.ts` routes clarification prompts/answers for both webhook and gateway flows.

State and configuration:
- Sessions persist under `~/.pulse-coder/remote-sessions` (`index.json` + `sessions/*.json`).
- Memory logs use `pulse-coder-memory-plugin` at `~/.pulse-coder/remote-memory`.
- Worktree binding state uses `~/.pulse-coder/worktree-state`.
- Model overrides are read from `.pulse-coder/config.json` or `$PULSE_CODER_MODEL_CONFIG` (`apps/remote-server/src/core/model-config.ts`).

Platform adapters:
- Feishu: `apps/remote-server/src/adapters/feishu/*` (event parsing, dedupe, cards, image replies).
- Discord: webhooks in `adapters/discord/adapter.ts` and DM gateway in `adapters/discord/gateway.ts`.
- Telegram and Web adapters exist but are not mounted by default.

Internal automation:
- `POST /internal/agent/run` runs an agent turn and can notify Feishu/Discord targets.
- `GET /internal/discord/gateway/status` and `POST /internal/discord/gateway/restart` manage the gateway.
- Internal routes are loopback-only and require `INTERNAL_API_SECRET`.

Remote server tools:
- Registered in `apps/remote-server/src/core/engine-singleton.ts` (cron scheduler, deferred demo, Twitter list fetcher, session summary, and PTC demo tools).
- Some tools are `defer_loading: true` and only load after tool search discovery.

## Configuration

Environment variables (common):
- `OPENAI_API_KEY`, `OPENAI_API_URL`, `OPENAI_MODEL`
- optional Anthropic path: `USE_ANTHROPIC`, `ANTHROPIC_API_KEY`, `ANTHROPIC_API_URL`, `ANTHROPIC_MODEL`
- optional tools: `TAVILY_API_KEY`, `GEMINI_API_KEY`

Config paths:
- MCP: `.pulse-coder/mcp.json`
- skills: `.pulse-coder/skills/**/SKILL.md`
- sub-agents: `.pulse-coder/agents/*.md`
- legacy `.coder/*` paths remain compatible in most loaders.

## Coding Guidance

- TypeScript strict mode is enabled.
- Keep ESM-style imports in source where existing code uses them.
- Follow local file style (2 spaces, semicolons, single quotes in most TS files).
- Keep diffs minimal and preserve existing architecture patterns.
- Prefer extending plugin/hooks/tool boundaries rather than hardcoding behavior into the loop.

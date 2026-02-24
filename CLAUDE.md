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
- `apps/pulse-agent-test`: lightweight integration checks.
- `apps/coder-demo`: legacy experimental app.
- `apps/snake-game`: static demo page.

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

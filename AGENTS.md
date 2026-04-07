# Repository Guidelines

## Project Structure & Module Organization
This repo is a `pnpm` monorepo with workspaces in `packages/*` and `apps/*`.

- `packages/engine`: core agent engine, built-in tools, plugin loading, and runtime loop.
- `packages/cli`: interactive terminal CLI built on `pulse-coder-engine`.
- `packages/pulse-sandbox`: sandboxed JS execution runtime and `run_js` tool adapter.
- `packages/memory-plugin`: memory integration/service package.
- `apps/remote-server`: optional HTTP service wrapper around the engine.
- `apps/coder-demo`: legacy experimental app.

Primary source code lives under each package/app `src/` directory; build output goes to `dist/`.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm run build`: build all workspaces recursively.
- `pnpm run dev`: watch mode for packages.
- `pnpm start`: run the CLI (`pulse-coder-cli`).
- `pnpm test`: run package tests (`./packages/*`).
- `pnpm run test:apps`: run app tests (`./apps/*`).
- `pnpm --filter pulse-coder-engine typecheck`: strict TS typecheck for engine.

Useful package targets:
- `pnpm --filter pulse-coder-engine test`
- `pnpm --filter pulse-coder-cli test`
- `pnpm --filter pulse-sandbox test`
- `pnpm --filter pulse-coder-memory-plugin test`
- `pnpm --filter @pulse-coder/remote-server build`
- `pnpm --filter @pulse-coder/remote-server dev`

Note: `apps/coder-demo` uses a placeholder test script, so app-level test runs may fail until it is replaced.

## Remote server notes (`apps/remote-server`)
- Entry point: `apps/remote-server/src/index.ts` bootstraps session store, memory integration, worktree binding, and engine.
- HTTP server: `apps/remote-server/src/server.ts` mounts `/health`, webhook routes, and `/internal/*` routes.
- Dispatcher: `apps/remote-server/src/core/dispatcher.ts` owns signature verification, fast ack, command parsing, and streaming.
- Sessions: stored in `~/.pulse-coder/remote-sessions` with `index.json` + `sessions/*.json`.
- Memory logs: stored in `~/.pulse-coder/remote-memory` via `pulse-coder-memory-plugin`.
- Worktree binding: stored in `~/.pulse-coder/worktree-state` via `pulse-coder-plugin-kit`.
- Internal API: `/internal/agent/run` is loopback-only and requires `INTERNAL_API_SECRET`.
- Platform adapters: Feishu and Discord are mounted; Telegram/Web adapters exist but are not enabled by default.

## Coding Style & Naming Conventions
Use TypeScript with strict mode and keep style consistent with neighboring files:
- 2-space indentation, semicolons, and single quotes in most TS code.
- `PascalCase` for classes/types (`Engine`, `PluginManager`).
- `camelCase` for variables/functions.
- `kebab-case` for multi-word file names (`session-commands.ts`).
- `UPPER_SNAKE_CASE` for exported constants.

No repository-wide ESLint/Prettier enforcement is guaranteed; keep diffs minimal and focused.

## Testing Guidelines
Vitest is used across core packages. Name tests `*.test.ts` or `*.spec.ts` and keep them near related source files.

Add tests for behavior changes in:
- loop control and compaction behavior,
- plugin/tool registration and hook behavior,
- CLI command handling and session workflows,
- memory integration boundaries.


## Commit & Pull Request Guidelines
Follow Conventional Commits (scope optional):
- `feat(engine): ...`
- `fix(cli): ...`
- `chore: ...`

PRs should include:
- clear summary and affected package(s),
- linked issue (if applicable),
- test evidence (commands and results),
- terminal evidence/screenshots for CLI UX changes when relevant.

## Security & Configuration Tips
- Keep secrets in local `.env` files only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `GEMINI_API_KEY`, etc.).
- Never commit credentials, local session data, or private memory databases.
- Prefer `.pulse-coder/*` config paths; legacy `.coder/*` paths exist for compatibility.

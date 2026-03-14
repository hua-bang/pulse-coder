# Repository Guidelines

## Project Structure & Module Organization
This is a `pnpm` monorepo with workspaces under `packages/*` and `apps/*`. Source code lives in each workspace’s `src/` directory and build output is emitted to `dist/`. Key areas:
- `packages/engine`: core agent engine, built-in tools, plugin loading, runtime loop.
- `packages/cli`: interactive terminal CLI built on `pulse-coder-engine`.
- `packages/pulse-sandbox`: sandboxed JS execution runtime and `run_js` tool adapter.
- `packages/memory-plugin`: memory integration/service package.
- `apps/remote-server`: optional HTTP service wrapper around the engine.
- `apps/pulse-agent-test`: lightweight integration checks.
- `apps/coder-demo`: legacy experimental app.

## Build, Test, and Development Commands
- `pnpm install`: install all workspace dependencies.
- `pnpm run build`: build all workspaces recursively.
- `pnpm run dev`: watch mode for packages.
- `pnpm start`: run the CLI (`pulse-coder-cli`).
- `pnpm test`: run package tests (`packages/*`).
- `pnpm run test:apps`: run app tests (`apps/*`). Note: `apps/coder-demo` has a placeholder test script and may fail.
- `pnpm --filter @pulse-coder/remote-server dev`: run the remote server in dev mode.
- `pnpm --filter @pulse-coder/remote-server build`: build only the remote server.
- `pnpm --filter pulse-coder-engine typecheck`: strict TS typecheck for the engine.

Useful package targets:
- `pnpm --filter pulse-coder-engine test`
- `pnpm --filter pulse-coder-cli test`
- `pnpm --filter pulse-sandbox test`
- `pnpm --filter pulse-coder-memory-plugin test`

## Coding Style & Naming Conventions
Use TypeScript in strict mode. Prefer 2-space indentation, semicolons, and single quotes. Naming: `PascalCase` for classes/types, `camelCase` for functions/vars, `kebab-case` for multi-word filenames, and `UPPER_SNAKE_CASE` for exported constants. No repo-wide formatter is enforced, so keep diffs minimal and follow nearby patterns.

## Remote Server Notes (`apps/remote-server`)
- Entry point: `apps/remote-server/src/index.ts` bootstraps session store, memory integration, worktree binding, and engine.
- HTTP server: `apps/remote-server/src/server.ts` mounts `/health`, webhook routes, and `/internal/*` routes.
- Dispatcher: `apps/remote-server/src/core/dispatcher.ts` owns signature verification, fast ack, command parsing, and streaming.
- Sessions: stored in `~/.pulse-coder/remote-sessions` with `index.json` + `sessions/*.json`.
- Memory logs: stored in `~/.pulse-coder/remote-memory` via `pulse-coder-memory-plugin`.
- Worktree binding: stored in `~/.pulse-coder/worktree-state` via `pulse-coder-plugin-kit`.
- Internal API: `/internal/agent/run` is loopback-only and requires `INTERNAL_API_SECRET`.
- Platform adapters: Feishu and Discord are mounted; Telegram/Web adapters exist but are not enabled by default.

## Testing Guidelines
Vitest is the primary test runner. Name tests `*.test.ts` or `*.spec.ts` and keep them near the related source. Add tests for changes to loop control, plugin hooks, CLI workflows, and memory integration boundaries.

## Commit & Pull Request Guidelines
Use Conventional Commits (scope optional), e.g. `feat(engine): add plugin hook` or `fix(cli): handle empty input`. PRs should include a clear summary, affected packages, linked issue (if any), and test evidence (commands + results). Provide screenshots for CLI UX changes when relevant.

## Security & Configuration Tips
Store secrets in local `.env` files only (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `GEMINI_API_KEY`). Do not commit local session or memory data under `.pulse-coder/*`. The internal API route `/internal/agent/run` is loopback-only and requires `INTERNAL_API_SECRET`.

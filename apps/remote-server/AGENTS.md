# Repository Guidelines

## Project Structure & Module Organization
This is a `pnpm` monorepo with workspaces under `packages/*` and `apps/*`. Source code lives in each workspace’s `src/` directory and build output is emitted to `dist/`. Key areas:
- `packages/engine`: core agent engine, tools, plugins, runtime loop.
- `packages/cli`: interactive terminal CLI.
- `packages/pulse-sandbox`: sandboxed JS runtime and `run_js` adapter.
- `packages/memory-plugin`: memory integration.
- `apps/remote-server`: HTTP service wrapper around the engine.
- `apps/pulse-agent-test`: integration checks.

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

## Coding Style & Naming Conventions
Use TypeScript in strict mode. Prefer 2-space indentation, semicolons, and single quotes. Naming: `PascalCase` for classes/types, `camelCase` for functions/vars, `kebab-case` for multi-word filenames, and `UPPER_SNAKE_CASE` for exported constants. No repo-wide formatter is enforced, so keep diffs minimal and follow nearby patterns.

## Testing Guidelines
Vitest is the primary test runner. Name tests `*.test.ts` or `*.spec.ts` and keep them near the related source. Add tests for changes to loop control, plugin hooks, CLI workflows, and memory integration boundaries.

## Commit & Pull Request Guidelines
Use Conventional Commits (scope optional), e.g. `feat(engine): add plugin hook` or `fix(cli): handle empty input`. PRs should include a clear summary, affected packages, linked issue (if any), and test evidence (commands + results). Provide screenshots for CLI UX changes when relevant.

## Security & Configuration Tips
Store secrets in local `.env` files only (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Do not commit local session or memory data under `.pulse-coder/*`. The internal API route `/internal/agent/run` is loopback-only and requires `INTERNAL_API_SECRET`.

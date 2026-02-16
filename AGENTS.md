# Repository Guidelines

## Project Structure & Module Organization
This repo is a `pnpm` monorepo.
- `packages/engine`: core agent engine, built-in tools, plugin loading, and config.
- `packages/cli`: terminal CLI built on `pulse-coder-engine`.
- `apps/coder-demo`: demo app (not part of publishable packages).
- `apps/pulse-agent-test`: lightweight Node-based integration checks.
- `docs/`: architecture, plugin, and MCP documentation.

Primary source code lives under each package’s `src/` directory; build output goes to `dist/`.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm run build`: build all workspaces recursively.
- `pnpm run dev`: watch mode for all workspaces.
- `pnpm start`: run the CLI (`pulse-coder-cli`).
- `pnpm --filter pulse-coder-engine test`: run engine Vitest suite.
- `pnpm --filter pulse-coder-cli test`: run CLI Vitest suite.
- `pnpm --filter pulse-coder-engine typecheck`: strict TS type check for engine.

Note: `pnpm test` currently fails because `apps/coder-demo` still has a placeholder test script.

## Coding Style & Naming Conventions
Use TypeScript with `strict` mode and ESM-oriented imports. Follow existing style:
- 2-space indentation, semicolons, and single quotes.
- `PascalCase` for classes/types (`Engine`, `PluginManager`).
- `camelCase` for variables/functions.
- `kebab-case` for multi-word file names (`session-commands.ts`).
- `UPPER_SNAKE_CASE` for exported constants.

No repo-wide ESLint/Prettier config is enforced; keep diffs minimal and consistent with neighboring files.

## Testing Guidelines
Vitest is used in `packages/engine` and `packages/cli`. Name tests `*.test.ts` or `*.spec.ts` and keep them near relevant source files. Add tests for behavior changes in loop logic, plugin/tool registration, and CLI command handling.

For quick integration smoke checks, use `apps/pulse-agent-test` (`pnpm --filter pulse-agent-test test`).

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits with optional scope:
- `feat(engine): ...`
- `fix: ...`
- `chore: ...`

PRs should include:
- clear summary and affected package(s),
- linked issue (if applicable),
- test evidence (commands + results),
- terminal output snippets for CLI behavior changes.

## Security & Configuration Tips
Keep secrets in local `.env` files only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Never commit credentials or session data.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Coder is a plugin-based AI coding assistant built as a TypeScript monorepo. It provides an interactive CLI that uses OpenAI-compatible LLMs with a modular skill/plugin system for code generation, review, refactoring, and research tasks.

## Build & Development Commands

```bash
pnpm install              # Install all dependencies (requires pnpm 10.28.0)
pnpm run build            # Build all packages (engine -> skills -> cli)
pnpm run dev              # Watch mode for all packages
pnpm start                # Run the CLI (@coder/cli)
pnpm test                 # Run all tests (vitest)
pnpm run clean            # Remove dist directories

# Per-package commands
pnpm --filter @coder/engine build   # Build just engine
pnpm --filter @coder/engine test    # Test just engine
pnpm --filter @coder/cli dev        # Dev mode for CLI
```

Build tool is tsup (ESM-only, target ES2022). Each package has its own `tsup.config.ts`.

## Architecture

### Monorepo Structure (pnpm workspaces)

Three core packages with a dependency chain: **engine** <- **skills** <- **cli**

- **`packages/engine`** (`@coder/engine`) - Core AI engine: LLM integration via Vercel AI SDK, agent loop, context compaction, built-in tools, plugin system, and configuration
- **`packages/skills`** (`@coder/skills`) - Skill plugin system: discovers and loads `SKILL.md` files from `.coder/skills/` directories, converts them to tools via a registry/scanner pattern
- **`packages/cli`** (`@coder/cli`) - Interactive CLI: readline interface, session management (save/load/resume/search), command system (`/new`, `/resume`, `/sessions`, etc.)

### Agent Loop (`packages/engine/src/core/loop.ts`)

The main execution flow: receives a `Context` (message array), calls the LLM via `streamTextAI()` with registered tools, processes streaming chunks (text deltas, tool calls, tool results), appends step responses back to context messages, and loops on `tool-calls` finish reason until `stop` or limits are hit. Handles context compaction when token count exceeds 75% of context window (configurable). Retries on 429/5xx errors with exponential backoff.

### Plugin System (`packages/engine/src/shared/types.ts`)

Plugins implement `IPlugin` with `activate(context)` to register tools. Extension types: `skill`, `mcp`, `tool`, `context`. The `Engine` class loads plugins and merges their tools with built-in tools before passing to the loop.

### Built-in Tools

`read`, `write`, `bash`, `ls` (file operations), `tavily` (web search). Defined in `packages/engine/src/tools/`.

### Skill System (`packages/skills/src/registry/`)

Skills are `SKILL.md` files with YAML frontmatter (`name`, `description`, `version`, `author`) and markdown body. The scanner discovers skills from `.coder/skills/`, `.claude/skills/`, and `~/.coder/skills/`. Six built-in skills live in `packages/cli/.coder/skills/`: branch-naming, code-review, deep-research, git-workflow, mr-generator, refactor.

### Configuration (`packages/engine/src/config/index.ts`)

Key environment variables:
- `OPENAI_API_KEY` (required), `OPENAI_API_URL`, `OPENAI_MODEL` (default: `novita/deepseek/deepseek_v3`)
- `CONTEXT_WINDOW_TOKENS` (default 64000), `COMPACT_TRIGGER` (75%), `COMPACT_TARGET` (50%), `KEEP_LAST_TURNS` (6)
- `MAX_STEPS` (25), `MAX_TURNS` (50), `MAX_ERROR_COUNT` (3)

## Key Technical Details

- ESM-only (`"type": "module"` in all package.json files)
- TypeScript strict mode enabled
- Vercel AI SDK v6 (`ai` package) with `@ai-sdk/openai` provider
- Schema validation via Zod v4
- Session data stored as JSON in `~/.coder/sessions/`
- `apps/` directory contains example applications (coder-demo, snake-game) - these are not part of the core packages

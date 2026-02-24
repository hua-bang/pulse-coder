# Pulse Coder

Plugin-first coding agent monorepo with a reusable engine, an interactive CLI, and optional server/runtime integrations.

## Language
- English docs (this file)
- Chinese docs: [`README-CN.md`](./README-CN.md)

## Repository layout

This repo is a `pnpm` workspace monorepo:

| Path | Purpose |
| --- | --- |
| `packages/engine` | Core runtime (`pulse-coder-engine`): loop, hooks, built-in tools, plugin manager |
| `packages/cli` | Interactive terminal app (`pulse-coder-cli`) built on top of the engine |
| `packages/pulse-sandbox` | Sandboxed JavaScript executor and `run_js` tool adapter |
| `packages/memory-plugin` | Host-side memory plugin/integration service |
| `apps/remote-server` | Optional HTTP service wrapper around the engine |
| `apps/pulse-agent-test` | Lightweight integration checks for engine usage |
| `apps/coder-demo` | Older experimental app |
| `apps/snake-game` | Static demo page |
| `docs/`, `architecture/` | Design and architecture documents |

---

## Architecture (current)

### 1) Engine bootstrap
`Engine.initialize()` creates a `PluginManager`, loads built-in plugins by default, then merges tools in this order:
1. built-in tools,
2. plugin-registered tools,
3. user-supplied tools (`EngineOptions.tools`, highest priority).

### 2) Plugin system
Two plugin tracks are supported:
- **Engine plugins**: runtime code plugins with lifecycle + hooks
- **User config plugins**: scanned config files (`config.{json|yaml|yml}`)

Engine plugin scan paths:
- `.pulse-coder/engine-plugins`
- `.coder/engine-plugins` (legacy)
- `~/.pulse-coder/engine-plugins`
- `~/.coder/engine-plugins`

### 3) Agent loop behavior
Core loop (`packages/engine/src/core/loop.ts`) provides:
- streaming text/tool events,
- LLM/tool hook pipelines (`before*`/`after*`),
- retry with backoff for retryable failures (`429/5xx`),
- abort handling,
- automatic context compaction.

### 4) Built-in plugins
The engine auto-loads:
- `built-in-mcp`: loads MCP servers from `.pulse-coder/mcp.json` (or `.coder/mcp.json`) and exposes tools as `mcp_<server>_<tool>`.
- `built-in-skills`: scans `SKILL.md` files and exposes the `skill` tool.
- `built-in-plan-mode`: planning/executing mode management.
- `built-in-task-tracking`: `task_create/task_get/task_list/task_update` with local persistence.
- `SubAgentPlugin`: loads Markdown agent definitions and exposes `<name>_agent` tools.

### 5) CLI runtime model
`pulse-coder-cli` adds:
- session persistence under `~/.pulse-coder/sessions`,
- per-session task-list binding,
- one-shot skill command transformation (`/skills ...`),
- ESC abort for in-flight responses,
- clarification flow via `clarify` tool,
- built-in `run_js` tool from `pulse-sandbox`.

---

## Built-in tools

Engine built-ins:
- `read`, `write`, `edit`, `grep`, `ls`, `bash`, `tavily`, `gemini_pro_image`, `clarify`

Task tracking plugin adds:
- `task_create`, `task_get`, `task_list`, `task_update`

CLI additionally injects:
- `run_js` (sandboxed JavaScript execution)

---

## Quick start

### Prerequisites
- Node.js `>=18`
- `pnpm` (workspace manager)

### 1) Install dependencies
```bash
pnpm install
```

### 2) Configure environment
Create `.env` at repo root:

```env
# OpenAI-compatible provider (default path)
OPENAI_API_KEY=your_key_here
OPENAI_API_URL=https://api.openai.com/v1
OPENAI_MODEL=novita/deepseek/deepseek_v3

# Optional Anthropic path
# USE_ANTHROPIC=true
# ANTHROPIC_API_KEY=...
# ANTHROPIC_API_URL=https://api.anthropic.com/v1
# ANTHROPIC_MODEL=claude-3-5-sonnet-latest

# Optional tools
# TAVILY_API_KEY=...
# GEMINI_API_KEY=...
```

### 3) Build
```bash
pnpm run build
```

### 4) Start CLI
```bash
pnpm start
```

---

## CLI commands

Inside the CLI:

- `/help`
- `/new [title]`
- `/resume <id>`
- `/sessions`
- `/search <query>`
- `/rename <id> <new-title>`
- `/delete <id>`
- `/clear`
- `/compact`
- `/skills [list|<name|index> <message>]`
- `/status`
- `/mode`
- `/plan`
- `/execute`
- `/save`
- `/exit`

Interactive controls:
- `Esc` aborts current response (or cancels pending clarification)
- `Ctrl+C` exits after save

---

## Configuration conventions

### MCP
Create `.pulse-coder/mcp.json`:

```json
{
  "servers": {
    "my_server": {
      "url": "http://localhost:3060/mcp/server"
    }
  }
}
```

### Skills
Create `.pulse-coder/skills/<skill-name>/SKILL.md`:

```md
---
name: my-skill
description: What this skill helps with
---

# Instructions
...
```

Optional remote skills config:
- `.pulse-coder/skills/remote.json`

### Sub-agents
Create `.pulse-coder/agents/<agent-name>.md`:

```md
---
name: code-reviewer
description: Specialized code review helper
---

System prompt content here.
```

> Legacy `.coder/...` paths are still supported.

---

## Development commands

### Workspace-level
```bash
pnpm install
pnpm run build
pnpm run dev
pnpm start
pnpm test
pnpm run test:apps
```

### Package-level
```bash
pnpm --filter pulse-coder-engine test
pnpm --filter pulse-coder-engine typecheck
pnpm --filter pulse-coder-cli test
pnpm --filter pulse-sandbox test
pnpm --filter pulse-coder-memory-plugin test
pnpm --filter pulse-agent-test test
```

Notes:
- `pnpm test` runs package tests (`./packages/*`).
- `pnpm run test:apps` runs app tests (`./apps/*`), and `apps/coder-demo` currently keeps a placeholder test script.

---

## Release

```bash
pnpm release
pnpm release:core
pnpm release -- --packages=engine,cli --bump=patch --tag=latest
```

Release script supports `--dry-run`, `--skip-version`, `--skip-build`, `--preid`, and package filtering.

---

## License

[MIT](./LICENSE)

# Pulse Coder

Plugin-first coding agent monorepo with a reusable engine, an interactive CLI, and a sandboxed JavaScript execution package.

## Language
- English README (this file)
- 中文文档: [`README-CN.md`](./README-CN.md)

## What this repository contains

This is a `pnpm` workspace monorepo:

| Path | Purpose |
| --- | --- |
| `packages/engine` | Core agent runtime (`pulse-coder-engine`): loop, tools, plugin manager, built-in plugins |
| `packages/cli` | Interactive terminal app (`pulse-coder-cli`) built on top of the engine |
| `packages/pulse-sandbox` | Isolated JS executor + `run_js` tool adapter |
| `apps/pulse-agent-test` | Lightweight integration checks for engine usage |
| `apps/coder-demo` | Older/experimental demo app |
| `apps/remote-server` | Optional HTTP service wrapper around the engine |
| `docs/`, `architecture/` | Design and architecture documents |

> Note: `packages/engine-plugins/` currently exists but is empty (reserved/legacy directory).

---

## Architecture (as implemented today)

### 1) Engine bootstrapping
`Engine.initialize()` creates a `PluginManager`, loads built-in plugins by default, then merges tools from:
1. built-in tools,
2. plugin-registered tools,
3. user-supplied tools (`EngineOptions.tools`, highest priority).

### 2) Plugin system
The engine has two loading tracks:
- **Engine plugins** (code plugins, with lifecycle and hook registration)
- **User config plugins** (`config.{json|yaml|yml}` scanning; currently mostly parsed/validated/logged)

Engine plugin scan paths include:
- `.pulse-coder/engine-plugins`
- `.coder/engine-plugins` (legacy compatible)
- `~/.pulse-coder/engine-plugins`
- `~/.coder/engine-plugins`

### 3) Agent loop behavior
Core loop (`packages/engine/src/core/loop.ts`) supports:
- streaming text/tool events,
- tool call hooks (`beforeToolCall` / `afterToolCall`),
- LLM call hooks (`beforeLLMCall` / `afterLLMCall`),
- retry with backoff for retryable failures (`429/5xx`),
- abort handling,
- automatic context compaction.

### 4) Built-in plugins
The engine auto-loads:
- `built-in-mcp`: loads MCP servers from `.pulse-coder/mcp.json` (or legacy `.coder/mcp.json`), exposes tools as `mcp_<server>_<tool>`.
- `built-in-skills`: scans `SKILL.md` files and exposes a `skill` tool.
- `built-in-plan-mode`: supports `planning`/`executing` mode with prompt-level policy injection and eventing.
- `built-in-task-tracking`: adds `task_create/task_get/task_list/task_update` tools with local JSON persistence.
- `SubAgentPlugin`: loads Markdown agent definitions and exposes `<name>_agent` tools.

### 5) CLI runtime model
`pulse-coder-cli` adds:
- session persistence under `~/.pulse-coder/sessions`,
- per-session task list binding,
- one-shot skill command transformation (`/skills ...`),
- ESC-based abort while streaming,
- clarification interaction via `clarify` tool,
- built-in `run_js` tool from `pulse-sandbox`.

---

## Built-in tools (engine)

Default toolset includes:
- `read`, `write`, `edit`, `grep`, `ls`, `bash`, `tavily`, `clarify`

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
Create a local `.env` at repo root (no root `.env.example` is currently shipped):

```env
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
OPENAI_API_URL=https://api.openai.com/v1
# Optional
# TAVILY_API_KEY=...
# USE_ANTHROPIC=true
# ANTHROPIC_API_KEY=...
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

### MCP servers
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
Create `.pulse-coder/skills/<skill-name>/SKILL.md` with frontmatter:

```md
---
name: my-skill
description: What this skill helps with
---

# Instructions
...
```

### Sub-agents
Create `.pulse-coder/agents/<agent-name>.md` with frontmatter:

```md
---
name: code-reviewer
description: Specialized code review helper
---

System prompt content here.
```

> Legacy `.coder/...` paths are still supported for compatibility.

---

## Programmatic usage (engine)

```ts
import { Engine } from 'pulse-coder-engine';
import { createOpenAI } from '@ai-sdk/openai';

const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const engine = new Engine({
  llmProvider: provider.responses,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  systemPrompt: { append: 'Prefer minimal diffs and keep tests green.' }
});

await engine.initialize();

const context = {
  messages: [{ role: 'user', content: 'Review this module and propose a refactor plan.' }]
};

const answer = await engine.run(context);
console.log(answer);
```

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
pnpm --filter pulse-agent-test test
```

Current test status in this repo:
- `pnpm test` (packages) passes.
- `pnpm run test:apps` currently fails because `apps/coder-demo` still has a placeholder test script.

---

## Release

```bash
pnpm release
pnpm release:core
pnpm release -- --packages=engine,cli --bump=patch --tag=latest
```

Release script supports `--dry-run`, `--skip-version`, `--skip-build`, `--preid`, and package filtering.

---

## Known caveats

- Some legacy helper scripts (`build.sh`, `quick-start.sh`) still reference older package naming/layout. Prefer `pnpm` scripts from `package.json`.
- `userConfigPlugins` loading is implemented, but many config sections are currently logged rather than fully materialized into runtime behavior.

---

## License

[MIT](./LICENSE)

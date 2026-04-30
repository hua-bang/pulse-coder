# Pulse Agent

一个以插件为核心的 Coding Agent Monorepo，包含可复用引擎、交互式 CLI、多 Agent 编排，以及可选的服务端 / 运行时集成。

## 语言
- English docs: [`README.md`](./README.md)
- 中文文档（当前）：`README-CN.md`

## 仓库结构

`pnpm` workspace monorepo（`packages/*`、`apps/*`）。

### Packages

| 路径 | npm 名 | 作用 |
| --- | --- | --- |
| `packages/engine` | `pulse-coder-engine` | 核心运行时：循环、hooks、内置工具、插件管理 |
| `packages/cli` | `pulse-coder-cli` | 终端交互应用 |
| `packages/pulse-sandbox` | `pulse-sandbox` | 沙箱 JavaScript 执行器与 `run_js` 适配 |
| `packages/memory-plugin` | `pulse-coder-memory-plugin` | memory 插件 / 集成服务 |
| `packages/plugin-kit` | `pulse-coder-plugin-kit` | 插件公共工具：worktree 辅助、密钥 vault、devtools 等 |
| `packages/orchestrator` | `pulse-coder-orchestrator` | 多 Agent 编排（TaskGraph、planner、scheduler、runner、aggregator） |
| `packages/agent-teams` | `pulse-coder-agent-teams` | 基于 orchestrator 的多 Agent 协作层 |
| `packages/acp` | `pulse-coder-acp` | Agent Context Protocol：typed client、runner、state store |
| `packages/langfuse-plugin` | `pulse-coder-langfuse-plugin` | 可选的 Langfuse 链路追踪插件 |
| `packages/canvas-cli` | `pulse-coder-canvas-cli` | canvas 相关 CLI 辅助 |

### Apps

| 路径 | 作用 |
| --- | --- |
| `apps/remote-server` | 引擎的 HTTP 封装（飞书 / Discord / Telegram 适配器） |
| `apps/teams-cli` | 多 Agent 团队工作流 CLI |
| `apps/canvas-workspace` | canvas 工作区应用 |
| `apps/coder-demo` | 早期实验 app |
| `apps/devtools-web` | 实验性 devtools Web UI |

> 实验 app（`apps/coder-demo`、`apps/devtools-web`）保留在仓库中，但默认不参与 workspace 安装 / 构建，详见 `apps/EXPERIMENTAL.md`。

其他目录：`docs/`、`architecture/`、`examples/`、`scripts/`。

---

## 当前架构

### 1）Engine 初始化
`Engine.initialize()`（`packages/engine/src/Engine.ts`）会创建 `PluginManager`，默认加载内置插件，按以下优先级合并工具：
1. 内置工具
2. 插件注册工具
3. 用户传入工具（`EngineOptions.tools`，最高优先级）

### 2）插件系统
两类插件链路：
- **Engine 插件**：代码级插件（生命周期 + hooks）
- **用户配置插件**：扫描配置文件（`config.{json|yaml|yml}`）

Engine 插件扫描路径：
- `.pulse-coder/engine-plugins`
- `.coder/engine-plugins`（兼容旧路径）
- `~/.pulse-coder/engine-plugins`
- `~/.coder/engine-plugins`

实现 `pulse-coder-engine` 中的 `EnginePlugin`，`initialize(ctx)` 提供：
- `ctx.registerTool(name, tool)` / `ctx.registerTools(map)`
- `ctx.registerHook(hookName, handler)`，覆盖 `EngineHookMap` 全部钩子
- `ctx.registerService(name, service)` / `ctx.getService(name)`
- `ctx.getConfig(key)` / `ctx.setConfig(key, val)`
- `ctx.events`（EventEmitter）、`ctx.logger`

### 3）Agent Loop
核心循环（`packages/engine/src/core/loop.ts`）支持：
- 文本 / 工具事件流式回调
- LLM hooks（`beforeLLMCall` / `afterLLMCall`）
- 工具 hooks（`beforeToolCall` / `afterToolCall` / `onToolCall`）
- Run 级 hooks（`beforeRun` / `afterRun`）；`beforeRun` 可改写 `systemPrompt` 与 `tools`
- 可重试错误的指数退避（`429/5xx`）
- 中断信号处理
- 自动上下文压缩（`onCompacted`）

### 4）内置插件（默认自动加载）
来自 `packages/engine/src/built-in/index.ts`：
- `built-in-mcp`：读取 `.pulse-coder/mcp.json`（兼容 `.coder/mcp.json`），工具命名为 `mcp_<server>_<tool>`
- `built-in-skills`：扫描 `SKILL.md` 并暴露 `skill` 工具
- `built-in-plan-mode`：planning / executing 模式管理
- `built-in-task-tracking`：`task_create/task_get/task_list/task_update`，本地持久化
- `SubAgentPlugin`：加载 `.pulse-coder/agents/*.md`，注册 `<name>_agent` 工具
- `tool-search`：延迟工具发现（按需加载工具 schema）
- `role-soul`：persona / system prompt 注入
- `agent-teams`：把 orchestrator 的多 Agent 协作以 engine 工具暴露
- `ptc`：PTC 工作流集成

### 5）CLI 运行模型
`pulse-coder-cli` 在引擎之上增加：
- 会话持久化（`~/.pulse-coder/sessions`）
- 会话级 task-list 绑定
- `/skills` 单次技能消息转换
- `Esc` 中断当前响应
- `clarify` 追问交互
- 注入来自 `pulse-sandbox` 的 `run_js` 工具

### 6）Orchestrator（`packages/orchestrator`）
执行 **TaskGraph** —— `TaskNode` 组成的 DAG：`{ id, role, deps[], input?, agent?, instruction? }`。

路由策略（`OrchestrationInput.route`）：
- `'auto'`：基于关键字的角色选择
- `'all'`：全部已注册角色都跑
- `'plan'`：由 LLM 动态构建图

内置角色：`researcher`、`executor`、`reviewer`、`writer`、`tester`，结果通过 `concat | last | llm` 聚合。`agent-teams` 插件把编排能力作为工具暴露给引擎。

### 7）Remote Server 运行时（`apps/remote-server`）
将引擎托管在 HTTP / Webhook 之后，支持飞书与 Discord（Telegram / Web 适配器存在但默认未挂载）。

关键组件：
- 入口与服务器：`apps/remote-server/src/index.ts`、`apps/remote-server/src/server.ts`（挂载 `/health`、webhook 路由、`/internal/*`）
- Dispatcher：`apps/remote-server/src/core/dispatcher.ts` —— 校验 / fast ack、slash 命令、按 `platformKey` 防并发、通过适配器 `StreamHandle` 流式输出
- Agent 执行：`apps/remote-server/src/core/agent-runner.ts` —— 构建上下文、解析模型 override、持久化会话、写入每日 memory
- Clarification：`apps/remote-server/src/core/clarification-queue.ts` —— webhook / gateway 的追问路由
- Sessions：`~/.pulse-coder/remote-sessions`（`index.json` + `sessions/*.json`）
- Memory：`pulse-coder-memory-plugin` 写入 `~/.pulse-coder/remote-memory`
- Worktrees：`~/.pulse-coder/worktree-state`
- 模型覆盖：`.pulse-coder/config.json` 或 `$PULSE_CODER_MODEL_CONFIG`（`apps/remote-server/src/core/model-config.ts`）
- 适配器：飞书（`adapters/feishu/*`）、Discord webhook（`adapters/discord/adapter.ts`）和 DM gateway（`adapters/discord/gateway.ts`）
- 内部 API：`POST /internal/agent/run`、`GET /internal/discord/gateway/status`、`POST /internal/discord/gateway/restart` —— 仅 loopback，需 `INTERNAL_API_SECRET`
- 工具：在 `apps/remote-server/src/core/engine-singleton.ts` 注册（cron、deferred demo、Twitter list fetcher、session summary、PTC demo），部分使用 `defer_loading: true`，由 tool-search 触发后再加载

---

## 内置工具

Engine 默认工具：
- `read`、`write`、`edit`、`grep`、`ls`、`bash`、`tavily`、`gemini_pro_image`、`clarify`

任务跟踪插件附加：
- `task_create`、`task_get`、`task_list`、`task_update`

CLI 额外注入：
- `run_js`（沙箱执行 JavaScript）

---

## 快速开始

### 前置要求
- Node.js `>=18`
- `pnpm`（`package.json` 中 pin 在 `pnpm@10.28.0`）

### 1）安装依赖
```bash
pnpm install
```

### 2）环境变量
在仓库根目录创建 `.env`：

```env
# OpenAI-compatible provider（默认）
OPENAI_API_KEY=your_key_here
OPENAI_API_URL=https://api.openai.com/v1
OPENAI_MODEL=novita/deepseek/deepseek_v3

# 可选 Anthropic
# USE_ANTHROPIC=true
# ANTHROPIC_API_KEY=...
# ANTHROPIC_API_URL=https://api.anthropic.com/v1
# ANTHROPIC_MODEL=claude-3-5-sonnet-latest

# 可选工具
# TAVILY_API_KEY=...
# GEMINI_API_KEY=...
```

### 3）构建
```bash
pnpm run build       # 核心工作区（packages/* + remote-server + teams-cli）
pnpm run build:all   # 全量工作区
```

### 4）启动 CLI
```bash
pnpm start
pnpm start:debug     # 带 debug 日志
```

### 5）Remote Server（可选）
```bash
pnpm --filter @pulse-coder/remote-server dev
```

### 6）多 Agent Teams 预览（可选）
```bash
pnpm preview:teams        # 构建 orchestrator/engine/agent-teams 后启动 teams-cli 预览
pnpm preview:teams:run    # run 模式预览
pnpm preview:teams:plan   # plan 模式预览
```

---

## CLI 命令

进入 CLI 后可用：

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

交互控制：
- `Esc`：中断当前响应（或取消等待中的 clarification）
- `Ctrl+C`：保存后退出

---

## 配置约定

### MCP
创建 `.pulse-coder/mcp.json`：

```json
{
  "servers": {
    "remote_http": {
      "transport": "http",
      "url": "http://localhost:3060/mcp/server"
    },
    "legacy_sse": {
      "transport": "sse",
      "url": "https://example.com/sse"
    },
    "local_stdio": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "."
    }
  }
}
```

说明：
- `transport` 支持 `http`、`sse`、`stdio`
- 未填写时默认按 `http` 处理（向后兼容）
- `http`/`sse` 使用 `url`（可选 `headers`）；`stdio` 使用 `command`（可选 `args`、`env`、`cwd`）

### Skills
创建 `.pulse-coder/skills/<skill-name>/SKILL.md`：

```md
---
name: my-skill
description: 该技能用于什么场景
---

# Instructions
...
```

可选远程技能配置：`.pulse-coder/skills/remote.json`。

### 子代理
创建 `.pulse-coder/agents/<agent-name>.md`：

```md
---
name: code-reviewer
description: 专用代码审查助手
---

System prompt content here.
```

> 兼容旧路径 `.coder/...`。

---

## 环境变量

通用：
- `OPENAI_API_KEY`、`OPENAI_API_URL`、`OPENAI_MODEL`
- Anthropic 路径：`USE_ANTHROPIC`、`ANTHROPIC_API_KEY`、`ANTHROPIC_API_URL`、`ANTHROPIC_MODEL`
- 可选工具：`TAVILY_API_KEY`、`GEMINI_API_KEY`
- 默认模型：`novita/deepseek/deepseek_v3`（用 `OPENAI_MODEL` / `ANTHROPIC_MODEL` 覆盖）

上下文压缩：
- `CONTEXT_WINDOW_TOKENS`（默认 `64000`）
- `COMPACT_TRIGGER`（默认 75%）、`COMPACT_TARGET`（默认 50%）、`KEEP_LAST_TURNS`（默认 `4`）
- `COMPACT_SUMMARY_MODEL`、`COMPACT_SUMMARY_MAX_TOKENS`（默认 `1200`）、`MAX_COMPACTION_ATTEMPTS`（默认 `2`）

Clarification：
- `CLARIFICATION_ENABLED`（默认 `true`）
- `CLARIFICATION_TIMEOUT`（默认 `300000` ms）

Remote Server：
- `INTERNAL_API_SECRET`：`/internal/*` 路由必填（仅 loopback）
- `PULSE_CODER_MODEL_CONFIG`：模型覆盖配置的可选路径

---

## 开发命令

### 工作区级别
```bash
pnpm install
pnpm run build         # 核心工作区（packages/* + remote-server + teams-cli，SKIP_DTS=1）
pnpm run build:all     # 全量工作区
pnpm run dev           # 核心工作区
pnpm run dev:all       # 全量工作区
pnpm start             # pulse-coder-cli
pnpm start:debug       # 带 debug 日志的 CLI
pnpm test              # 等价于 test:core
pnpm run test:core     # packages/* + remote-server + teams-cli
pnpm run test:packages # 仅 packages/*
pnpm run test:apps     # apps/*（coder-demo 占位脚本可能失败）
pnpm run test:all      # 全量
```

### 包级别
```bash
pnpm --filter pulse-coder-engine test
pnpm --filter pulse-coder-engine typecheck
pnpm --filter pulse-coder-cli test
pnpm --filter pulse-sandbox test
pnpm --filter pulse-coder-memory-plugin test
pnpm --filter pulse-coder-plugin-kit test
pnpm --filter pulse-coder-orchestrator test
pnpm --filter pulse-coder-agent-teams test
pnpm --filter @pulse-coder/remote-server build
pnpm --filter @pulse-coder/remote-server dev
```

所有包使用 **vitest**（`vitest run`）跑测试，`tsc --noEmit` 做类型检查。

说明：
- `pnpm-workspace.yaml` 当前仅纳入核心集合：`packages/*`、`apps/remote-server`、`apps/teams-cli`、`apps/canvas-workspace`。实验 app（`apps/coder-demo`、`apps/devtools-web`）保留在仓库但默认不参与安装 / 构建。
- 需要全量执行时使用 `build:all` / `dev:all` / `test:all`。

---

## 发版

```bash
pnpm release
pnpm release:core
pnpm release -- --packages=engine,cli --bump=patch --tag=latest
```

发版脚本（`scripts/release-packages.mjs`）支持 `--dry-run`、`--skip-version`、`--skip-build`、`--preid`、`--packages=` 等参数。

---

## License

[MIT](./LICENSE)

# Pulse Coder

一个以插件架构为核心的 Coding Agent Monorepo，包含可复用引擎、交互式 CLI，以及沙箱化 JavaScript 执行组件。

## 语言
- English README: [`README.md`](./README.md)
- 中文文档（当前）：`README-CN.md`

## 仓库当前组成

这是一个 `pnpm` workspace monorepo：

| 路径 | 作用 |
| --- | --- |
| `packages/engine` | 核心运行时（`pulse-coder-engine`）：循环、工具、插件管理、内置插件 |
| `packages/cli` | 终端交互应用（`pulse-coder-cli`） |
| `packages/pulse-sandbox` | 隔离 JS 执行器 + `run_js` 工具适配 |
| `apps/pulse-agent-test` | 轻量 Node 集成检查 |
| `apps/coder-demo` | 较早期/实验性 demo |
| `apps/remote-server` | 可选的 HTTP 服务封装 |
| `docs/`, `architecture/` | 设计与架构文档 |

> 说明：`packages/engine-plugins/` 目录当前为空（保留/历史遗留）。

---

## 当前实现下的核心架构

### 1）Engine 初始化流程
`Engine.initialize()` 会创建 `PluginManager`，默认加载内置插件，然后按优先级合并工具：
1. 内置工具
2. 插件注册工具
3. 用户传入工具（`EngineOptions.tools`，优先级最高）

### 2）插件系统
引擎有两条插件加载链路：
- **Engine 插件**（代码级插件，带生命周期与 hook）
- **用户配置插件**（扫描 `config.{json|yaml|yml}`，目前以解析/校验/日志为主）

Engine 插件扫描路径包括：
- `.pulse-coder/engine-plugins`
- `.coder/engine-plugins`（兼容旧路径）
- `~/.pulse-coder/engine-plugins`
- `~/.coder/engine-plugins`

### 3）Agent Loop 行为
核心循环（`packages/engine/src/core/loop.ts`）支持：
- 文本/工具事件流式回调
- 工具调用 hook（`beforeToolCall` / `afterToolCall`）
- LLM 调用 hook（`beforeLLMCall` / `afterLLMCall`）
- 可重试错误指数退避（`429/5xx`）
- 中断信号处理
- 自动上下文压缩

### 4）内置插件（默认自动加载）
- `built-in-mcp`：读取 `.pulse-coder/mcp.json`（兼容 `.coder/mcp.json`），工具命名为 `mcp_<server>_<tool>`
- `built-in-skills`：扫描 `SKILL.md`，暴露 `skill` 工具
- `built-in-plan-mode`：`planning` / `executing` 模式，按模式注入提示策略
- `built-in-task-tracking`：提供 `task_create/task_get/task_list/task_update`，本地 JSON 持久化
- `SubAgentPlugin`：加载 Markdown 子代理定义，注册 `<name>_agent` 工具

### 5）CLI 运行模型
`pulse-coder-cli` 在引擎之上增加：
- 会话持久化（`~/.pulse-coder/sessions`）
- 会话与 task list 绑定
- `/skills` 单次技能消息转换
- 流式输出中 Esc 中断
- `clarify` 工具的人机追问交互
- 注入来自 `pulse-sandbox` 的 `run_js` 工具

---

## 内置工具（engine）

默认工具：
- `read`, `write`, `edit`, `grep`, `ls`, `bash`, `tavily`, `clarify`

任务跟踪插件附加：
- `task_create`, `task_get`, `task_list`, `task_update`

CLI 额外注入：
- `run_js`（沙箱执行 JavaScript）

---

## 快速开始

### 前置要求
- Node.js `>=18`
- `pnpm`

### 1）安装依赖
```bash
pnpm install
```

### 2）环境变量
在仓库根目录手动创建 `.env`（当前未提供根目录 `.env.example`）：

```env
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
OPENAI_API_URL=https://api.openai.com/v1
# 可选
# TAVILY_API_KEY=...
# USE_ANTHROPIC=true
# ANTHROPIC_API_KEY=...
```

### 3）构建
```bash
pnpm run build
```

### 4）启动 CLI
```bash
pnpm start
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

### MCP 服务器
创建 `.pulse-coder/mcp.json`：

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
创建 `.pulse-coder/skills/<skill-name>/SKILL.md`：

```md
---
name: my-skill
description: 该技能用于什么场景
---

# Instructions
...
```

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

## 引擎 SDK 使用示例

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

## 开发命令

### 工作区级别
```bash
pnpm install
pnpm run build
pnpm run dev
pnpm start
pnpm test
pnpm run test:apps
```

### 包级别
```bash
pnpm --filter pulse-coder-engine test
pnpm --filter pulse-coder-engine typecheck
pnpm --filter pulse-coder-cli test
pnpm --filter pulse-sandbox test
pnpm --filter pulse-agent-test test
```

当前仓库测试现状：
- `pnpm test`（packages）可通过。
- `pnpm run test:apps` 目前会失败，因为 `apps/coder-demo` 仍是占位测试脚本。

---

## 发版

```bash
pnpm release
pnpm release:core
pnpm release -- --packages=engine,cli --bump=patch --tag=latest
```

支持 `--dry-run`、`--skip-version`、`--skip-build`、`--preid`、`--packages` 等参数。

---

## 已知注意事项

- 一些历史脚本（如 `build.sh`、`quick-start.sh`）仍引用旧包名/旧结构，建议优先使用 `package.json` 中的 `pnpm` 脚本。
- `userConfigPlugins` 机制已接入，但不少配置项目前主要是日志级处理，还未完全落地为运行时行为。

---

## License

[MIT](./LICENSE)

# Pulse Coder

一个以插件为核心的 Coding Agent Monorepo，包含可复用引擎、交互式 CLI，以及可选的服务端/运行时集成。

## 语言
- English docs: [`README.md`](./README.md)
- 中文文档（当前）：`README-CN.md`

## 仓库结构

这是一个 `pnpm` workspace monorepo：

| 路径 | 作用 |
| --- | --- |
| `packages/engine` | 核心运行时（`pulse-coder-engine`）：循环、hooks、内置工具、插件管理 |
| `packages/cli` | 终端交互应用（`pulse-coder-cli`） |
| `packages/pulse-sandbox` | 沙箱 JavaScript 执行器与 `run_js` 适配 |
| `packages/memory-plugin` | memory 插件/集成服务 |
| `apps/remote-server` | 可选 HTTP 服务封装 |
| `apps/pulse-agent-test` | 轻量集成检查 |
| `apps/coder-demo` | 早期实验 app |
| `apps/snake-game` | 静态 demo 页面 |
| `docs/`, `architecture/` | 设计与架构文档 |

---

## 当前架构

### 1）Engine 初始化
`Engine.initialize()` 会创建 `PluginManager`，默认加载内置插件，然后按优先级合并工具：
1. 内置工具
2. 插件注册工具
3. 用户传入工具（`EngineOptions.tools`，优先级最高）

### 2）插件系统
支持两类插件链路：
- **Engine 插件**：代码级插件（生命周期 + hooks）
- **用户配置插件**：扫描配置文件（`config.{json|yaml|yml}`）

Engine 插件扫描路径：
- `.pulse-coder/engine-plugins`
- `.coder/engine-plugins`（兼容旧路径）
- `~/.pulse-coder/engine-plugins`
- `~/.coder/engine-plugins`

### 3）Agent Loop 行为
核心循环（`packages/engine/src/core/loop.ts`）支持：
- 文本/工具事件流式回调
- LLM 与工具 hooks（`before*` / `after*`）
- 可重试错误指数退避（`429/5xx`）
- 中断信号处理
- 自动上下文压缩

### 4）内置插件（默认自动加载）
- `built-in-mcp`：读取 `.pulse-coder/mcp.json`（兼容 `.coder/mcp.json`），工具命名为 `mcp_<server>_<tool>`
- `built-in-skills`：扫描 `SKILL.md` 并暴露 `skill` 工具
- `built-in-plan-mode`：planning/executing 模式管理
- `built-in-task-tracking`：`task_create/task_get/task_list/task_update` 本地持久化
- `SubAgentPlugin`：加载 Markdown 子代理定义，注册 `<name>_agent` 工具

### 5）CLI 运行模型
`pulse-coder-cli` 在引擎之上增加：
- 会话持久化（`~/.pulse-coder/sessions`）
- 会话 task-list 绑定
- `/skills` 单次技能消息转换
- Esc 中断当前响应
- `clarify` 追问交互
- 注入来自 `pulse-sandbox` 的 `run_js` 工具

---

## 内置工具

Engine 默认工具：
- `read`, `write`, `edit`, `grep`, `ls`, `bash`, `tavily`, `gemini_pro_image`, `clarify`

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

### MCP
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

可选远程技能配置：
- `.pulse-coder/skills/remote.json`

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
pnpm --filter pulse-coder-memory-plugin test
pnpm --filter pulse-agent-test test
```

说明：
- `pnpm test` 仅运行 packages 测试（`./packages/*`）。
- `pnpm run test:apps` 运行 apps 测试（`./apps/*`），`apps/coder-demo` 当前仍是占位测试脚本。

---

## 发版

```bash
pnpm release
pnpm release:core
pnpm release -- --packages=engine,cli --bump=patch --tag=latest
```

支持 `--dry-run`、`--skip-version`、`--skip-build`、`--preid`、`--packages` 等参数。

---

## License

[MIT](./LICENSE)

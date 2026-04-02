# Agent Teams × Canvas Integration - PRD

## 1. Vision

在 Canvas Workspace 中实现多 Agent 协作的可视化编排与执行平台。用户可以通过自然语言描述目标或手动拖拽编排，创建由多种 runtime（pulse-agent / claude-code / codex）组成的 Agent Team，在 Canvas 上实时观察执行过程并随时交互干预。

## 2. Target Users

- **AI 应用开发者**：需要编排多个 AI agent 协作完成复杂任务
- **工程团队**：希望将大型任务拆分给多个 agent 并行执行，加速交付
- **AI 探索者**：希望可视化理解 agent 协作的过程和效果

## 3. Core Concepts

### 3.1 Workspace Agent

- Workspace 粒度的全局助手，每个 workspace 唯一
- 理解整个 workspace 的上下文（所有节点、文件、项目结构）
- 可以创建和管理多个 Team
- 回答用户关于整个项目的问题
- 决定一个目标需要拆成几个 Team
- UI 形态：侧边栏常驻面板 / 对话框，不占用 canvas 节点空间

### 3.2 Team

- 一组协作的 agent 的集合
- 在 canvas 上表现为一个 Frame 节点
- 包含一个 Team Lead Agent + N 个 Teammate Agent
- 拥有独立的 TaskList 和 Mailbox
- 一个 workspace 下可以有多个 Team 并行运行

### 3.3 Team Lead Agent

- 每个 Team 唯一，Team 创建时自动生成
- 负责 team 内的任务规划、分配、监控和结果汇总
- 对应 agent-teams 中的 `TeamLead` 概念
- 在 canvas 上表现为 Frame 内的一个特殊 agent 节点
- 特有 UI：目标输入、"Run Team" 按钮、全局进度条、结果汇总面板

### 3.4 Teammate Agent

- 执行具体任务的 agent
- 支持多种 runtime：pulse-agent / claude-code / codex
- 通过 MCP 调用 team 工具（TaskList + Mailbox）进行协调
- 在 canvas 上表现为 Frame 内的普通 agent 节点
- 内嵌 xterm 终端，支持实时输出展示和双向交互

### 3.5 Agent Node

Canvas 上的新节点类型，用于承载 agent 实例。复合组件包含：
- Header Bar：名称、runtime 标识、状态指示灯、操作按钮
- Task Panel：当前 agent 的任务列表和进度
- Terminal：xterm 终端，展示 agent 输出并支持用户输入
- Plan Review（条件出现）：plan mode 下的审批面板

### 3.6 Runtime

Agent 的执行环境，决定了底层使用哪个 AI CLI 工具：
- `pulse-agent`：可 in-process（Engine.run()）或 PTY 模式
- `claude-code`：PTY 模式，通过 MCP 接入 team 工具
- `codex`：PTY 模式，通过 MCP 接入 team 工具

### 3.7 Team MCP Server

本地 MCP server，将 agent-teams 的 TaskList + Mailbox 暴露为 MCP 协议工具。每个 Team 运行时启动一个实例，该 Team 内所有 agent 通过 MCP 配置连接到同一个 server。

## 4. User Scenarios

### 4.1 AI 自动规划 + 执行

```
1. 用户打开 workspace，在 Workspace Agent 面板输入：
   "重构整个项目的 API 模块，需要分析现有代码、重写实现、补充测试"

2. Workspace Agent 判断需要一个 Team，创建 Frame 节点

3. Frame 内的 Team Lead 调用 Planner，生成：
   - 3 个 Teammate：analyst(claude-code)、coder(pulse-agent)、tester(codex)
   - 5 个 Task，含依赖关系

4. Canvas 自动渲染出 3 个 agent 节点，排列在 Frame 内
   用户审查节点配置和任务列表

5. 用户调整：把 tester 的 runtime 改为 claude-code

6. 用户点击 "Run Team"

7. 3 个 agent 节点各自启动 CLI 会话
   analyst 立即开始执行（无依赖）
   coder 和 tester 等待依赖完成

8. 执行过程中：
   - 每个节点的 xterm 实时滚动输出
   - Task Panel 状态实时更新
   - analyst 通过 MCP 调用 team_complete_task，coder 自动 unblock

9. coder 执行中调用 clarify："是否保持向后兼容？"
   用户在 coder 的 xterm 里输入回答

10. 所有 task 完成，Team Lead 汇总结果展示
```

### 4.2 手动编排 + 执行

```
1. 用户在 canvas 右键 → "New Team"，创建一个 Frame
2. Frame 内自动生成一个 Team Lead 节点
3. 用户在 Frame 内右键 → "New Agent"，逐个添加 agent
4. 为每个 agent 设置 name、role、runtime、spawnPrompt
5. 在 Team Lead 或各 agent 节点上添加 tasks
6. 点击 "Run Team"
7. 观察执行，随时交互
```

### 4.3 大型目标拆分为多个 Team

```
1. 用户在 Workspace Agent 输入：
   "重构整个项目，包括 API 层、UI 层、测试和文档"

2. Workspace Agent 判断需要拆成 3 个 Team：
   - Team A: API 重构
   - Team B: UI 重构
   - Team C: 测试 + 文档

3. Canvas 上出现 3 个 Frame，每个有自己的 Lead + Teammates

4. 用户审查后一键全部执行或逐个执行
```

### 4.4 执行中交互

```
1. 用户直接在某个 agent 的 xterm 里打字，发送指令
2. agent 调用 clarify 提问时，用户在 xterm 回答
3. agent 提交 plan 时，Plan Review 面板弹出，用户 Approve/Reject
4. 用户点击 Pause/Stop 控制单个 agent
5. 用户追加新 task 给空闲的 agent
```

## 5. Agent Node UI Design

```
┌─ AgentNodeBody ─────────────────────────┐
│ ┌─ Header Bar ──────────────────────┐   │
│ │ [icon] researcher · claude-code    │   │
│ │ 🟢 running                        │   │
│ │ [Pause] [Stop]                     │   │
│ └────────────────────────────────────┘   │
│ ┌─ Task Panel (collapsible) ────────┐   │
│ │ ✓ Analyze API structure            │   │
│ │ ▶ Write interface docs  ← current  │   │
│ │ ○ Integration test (blocked)       │   │
│ └────────────────────────────────────┘   │
│ ┌─ Terminal (xterm) ────────────────┐   │
│ │ > Reading src/api/routes.ts...     │   │
│ │ > Found 12 endpoints               │   │
│ │ > Categorized into 3 groups        │   │
│ │ > _                                │   │
│ └────────────────────────────────────┘   │
│ ┌─ Plan Review (conditional) ───────┐   │
│ │ Plan: 1. Audit routes 2. Refactor │   │
│ │ [Approve] [Reject + feedback]      │   │
│ └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

### Lead Agent 节点额外 UI

```
┌─ LeadAgentNodeBody ─────────────────────┐
│ ┌─ Header Bar ──────────────────────┐   │
│ │ [crown] Team Lead · pulse-agent    │   │
│ │ [Run Team] [Stop All]              │   │
│ └────────────────────────────────────┘   │
│ ┌─ Goal Input ──────────────────────┐   │
│ │ "重构 API 模块..."                  │   │
│ └────────────────────────────────────┘   │
│ ┌─ Team Progress ───────────────────┐   │
│ │ ████████░░░░ 3/5 tasks · 60%       │   │
│ │ researcher: ✓✓▶  coder: ▶  test: ○ │   │
│ └────────────────────────────────────┘   │
│ ┌─ Terminal (xterm) ────────────────┐   │
│ │ Lead 的输出和交互                    │   │
│ └────────────────────────────────────┘   │
│ ┌─ Result Summary (after complete) ─┐   │
│ │ 汇总结果...                         │   │
│ └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

## 6. Workspace Agent UI Design

不占用 canvas 节点空间，作为 workspace 级别的常驻面板：

```
┌─ Sidebar / Panel ────────────────────┐
│ Workspace Agent                       │
│ ──────────────────────────────────── │
│ [input] "重构整个项目..."             │
│ ──────────────────────────────────── │
│ Teams:                                │
│   ● Team A: API 重构  [running]      │
│   ● Team B: UI 重构   [idle]         │
│   ○ Team C: 测试      [pending]      │
│ ──────────────────────────────────── │
│ Chat history with workspace agent... │
└───────────────────────────────────────┘
```

## 7. Scope

### 7.1 In Scope (MVP)

- Agent 节点类型（含 Lead 和 Teammate 两种角色）
- Multi-runtime 支持（pulse-agent / claude-code / codex）
- Team MCP Server（TaskList + Mailbox 工具暴露）
- PTY 执行模式 + xterm 双向交互
- Team 编排（手动 + AI Planner）
- Team 执行 + 实时状态展示
- 保留 in-process Engine 作为 pulse-agent 的基础执行模式

### 7.2 Out of Scope (MVP)

- Edge 系统（可视化依赖连线）
- Workspace Agent（Phase 6）
- 跨 Team 协调
- Agent 模板市场
- 执行历史回放
- Skill + Canvas CLI 替代通道

## 8. Success Metrics

- 能在 canvas 上创建 agent 节点并配置属性
- 能启动单个 agent 并在 xterm 中实时查看输出和交互
- 能编排多 agent team 并一键执行
- TaskList 依赖自动解锁正常工作
- 三种 runtime 均可通过 MCP 调用 team 工具
- AI Planner 规划结果能正确渲染为 canvas 节点

## 9. Open Questions

- Workspace Agent 的具体 UI 形态：独立侧边栏 vs 浮动面板 vs 对话抽屉？
- Agent 节点的默认尺寸：需要容纳 header + task panel + xterm，可能比现有节点更大
- PTY 模式下 pulse-agent 的 CLI 入口：是否需要新增 `pulse-agent` 可执行命令？
- 多个 Team 并行时的资源限制：同时运行的 agent 数量上限？
- Team 执行状态的持久化：workspace 关闭后重新打开能否恢复执行现场？

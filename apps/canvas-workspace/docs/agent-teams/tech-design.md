# Agent Teams on Canvas — 技术方案 (Tech Design)

**Status**: Draft v0.2
**Owner**: Jasper
**Last updated**: 2026-04-25
**对应 PRD**: [`prd.md`](./prd.md)

> **v0.2 修订**：实现路线从 MCP HTTP server 改为 `pulse-canvas` CLI 子命令。
> 原因：canvas-workspace 主进程已注释禁用 MCP server (`apps/canvas-workspace/src/main/index.ts:8-10, 146-148`)，
> 当前 agent 接入方式是 canvas-cli 直接读写 JSON store。Skills 系统已经在教 agent 用 CLI，
> 团队工具延续这个模式更自然。详见 §0 决策对比。

---

## 0. TL;DR

把 `packages/agent-teams` 的 `TaskList` + `Mailbox` 文件协议直接复用，把 PTY agent 节点通过 frame 包成 team，让 lead agent 通过 **`pulse-canvas team` 子命令**协调画布上的 teammates（agent 用 bash 工具调 CLI，所有状态走 `~/.pulse-coder/teams/{teamId}/`）。所有 teammates 都是 PTY 节点；canvas chat panel 是创建 team 的入口，**不是** team 成员。

### 0.1 为什么用 CLI 不是 MCP

| 维度 | MCP HTTP server | `pulse-canvas` CLI |
|------|----------------|---------------------|
| 项目方向 | 已被注释禁用 | 已是 agent 接入主路径 |
| Agent 调用方式 | 必须支持 MCP + 注册 | 任何能跑 bash 的 agent 都行 |
| 协议本质 | HTTP RPC 包装文件 IO | 直接文件 IO |
| 部署复杂度 | 启动顺序 / 端口 / 注册 | 单二进制，无 server |
| 教 agent 学会用 | 工具描述 + 客户端支持 | Skills 文档已成熟 |
| 进程数 | +1 server | 0 |

唯一相对劣势：MCP 的 streaming 比 CLI 轮询优雅 — 但这是 v1.1 优化项，MVP 用 5s 轮询足够（§3.2）。

---

## 1. 架构总览

### 1.1 进程拓扑

```
┌─ Electron Main Process ─────────────────────────────────────────────┐
│                                                                       │
│  ┌─ Canvas Chat Panel (in-process Engine) ─┐                          │
│  │  - 用户的指挥入口                          │                          │
│  │  - 不属于任何 team                          │                          │
│  │  - 通过 child_process spawn pulse-canvas  │                          │
│  └────────────────────────┬──────────────────┘                          │
│                            │                                             │
└────────────────────────────┼─────────────────────────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────────────┐
   │                                                             │
   ▼                                                             ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐    每个 PTY 进程都
│ Lead PTY     │  │ Teammate PTY │  │ Teammate PTY │    在自己 cwd 调用
│ (claude)     │  │ (codex)      │  │ (pulse-coder)│    pulse-canvas team ...
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                  │
       │ pulse-canvas    │ pulse-canvas    │ pulse-canvas
       │ team msg ...    │ team task ...   │ team task ...
       ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/canvas-cli/dist/index.cjs (binary: pulse-canvas)   │
│   ├─ commands/team.ts   (10 个 team 子命令)                   │
│   └─ core/team.ts       (TeamRuntime 缓存 + 文件协议)         │
└─────────────────────────┬────────────────────────────────────┘
                          │ 文件 IO
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  ~/.pulse-coder/teams/{teamId}/                              │
│   ├── config.json    (team 元数据)                            │
│   ├── tasks/tasks.json + tasks.lock                          │  ← 复用 TaskList
│   └── mailbox/{memberId}.json                                │  ← 复用 Mailbox
└──────────────────────────────────────────────────────────────┘
```

### 1.2 关键观察

每次 `pulse-canvas team` 调用是**独立短命进程**（< 50ms），没有常驻 server。这意味着：

- **TeamRuntime 缓存只活在单次调用内** — `core/team.ts` 里 `runtimes: Map<teamId, TeamRuntime>` 只在一次进程生命周期里有效
- **跨进程一致性靠文件锁** — `TaskList` 已经实现 `O_EXCL` 锁，多个并发的 `pulse-canvas team task claim` 不会互相覆盖
- **Electron app 的 fs.watch** 自动感知 `~/.pulse-coder/canvas/{wsId}/canvas.json` 变化（已存在的机制），team 状态变化的实时反映靠**画布上 tasks-view file 节点**指向 team 状态目录里的派生 markdown
- **Lead 的协调循环**通过 PTY 跑 `bash sleep 5 && pulse-canvas team status ...` 这种简单循环，由 lead agent 自己驱动

### 1.2 实体定义

| 实体 | 形态 | 寿命 | 标识 |
|------|------|------|------|
| **CanvasTeam** | Frame 节点 + `teamMeta` 字段 | 用户显式删除 frame 才结束 | `teamMeta.teamId`（UUID，与 frame.id 解耦） |
| **Lead Agent** | PTY 节点（`agent` 类型）| PTY 关闭即 lead 离线，team 进入"无主"状态 | `teamMeta.leadNodeId` |
| **Teammate** | PTY 节点（`agent` 类型）| PTY 关闭即 teammate 离队 | `AgentNodeData.teamMembership.{teamId, memberId}` |
| **Tasks** | `~/.pulse-coder/teams/{teamId}/tasks/tasks.json` | 与 team frame 共生 | Task 自身的 UUID |
| **Mailbox** | `~/.pulse-coder/teams/{teamId}/mailbox/{memberId}.json` | 与 team frame 共生 | `memberId`（teammate 内部 ID） |
| **Tasks 视图节点** | `file` 节点，filePath 指向上面 tasks.json 的人类可读镜像 | 自动随 tasks 变化重渲染 | 普通 nodeId |

**关键澄清（与 PRD F3 的措辞统一）**：

PRD 把"共享任务板"描述为 `tasks.md`，但复用的 `TaskList` 使用 JSON 作为 source of truth。设计上**两者都要有，分工明确**：

- **`tasks.json`**（source of truth）：`packages/agent-teams` 的 `TaskList` 写入；agent 通过 `pulse-canvas team task ...` 操作；不直接显示给用户
- **`tasks.md`**（派生视图）：JSON → markdown 的渲染产物；作为 file 节点显示在画布；只读（用户编辑会被覆盖）

这样既复用了底层并发安全的 JSON 协议，又满足了 PRD 要求的"画布上看得见任务板"。

---

## 2. 数据模型

### 2.1 `FrameNodeData` 扩展

```ts
// 现有
export interface FrameNodeData {
  color: string;
  label?: string;
}

// 扩展后
export interface FrameNodeData {
  color: string;
  label?: string;
  /** 存在 → 这是个 Team Frame；不存在 → 普通 frame */
  teamMeta?: TeamMeta;
}

export interface TeamMeta {
  /** 全局唯一 team id（UUID）。和 frame.id 解耦：frame 被复制/移动时 teamId 不变 */
  teamId: string;
  /** 用户可见的 team 名 */
  teamName: string;
  /** 哪个 agent 节点是 lead（nodeId） */
  leadNodeId?: string;
  /** 状态目录，默认 ~/.pulse-coder/teams/{teamId}/ */
  stateDir: string;
  /** Tasks 视图节点 id（file node），用于 lead 知道往哪个节点广播任务变化 */
  tasksViewNodeId?: string;
  createdAt: number;
}
```

### 2.2 `AgentNodeData` 扩展

```ts
export interface AgentNodeData {
  // ... 现有字段
  sessionId: string;
  cwd?: string;
  agentType: string;
  status?: 'idle' | 'running' | 'done' | 'error';
  agentArgs?: string;
  inlinePrompt?: string;
  promptFile?: string;

  // 新增
  /** 该节点的 team 归属。null/undefined = 不在任何 team 中 */
  teamMembership?: {
    teamId: string;
    /** 在 team 内的稳定 ID（写入 mailbox 路径），独立于 nodeId 以便重启可保持身份 */
    memberId: string;
    /** 是否 lead */
    isLead: boolean;
    /** 加入时间，用于审计 */
    joinedAt: number;
  };
}
```

**关键设计点**：

- **`teamMembership` 显式存储**，不是每次靠 frame 几何重算。理由：用户拖动 agent 节点出 frame 时，应该弹窗确认"是否离队"而不是静默离队。几何归属只用于"创建时自动加入"和"UI 可视化"。
- **`memberId` ≠ `nodeId`**：memberId 一旦分配就不变（即使节点被复制、PTY 重启），保证 mailbox 文件的连续性。

### 2.3 `tasks.json` 格式（直接复用 `Task` 类型）

```ts
// 来自 packages/agent-teams/src/types.ts
export interface Task {
  id: string;              // UUID
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  deps: string[];          // 依赖的 task id 列表
  assignee: string | null; // memberId
  createdBy: string;       // memberId
  createdAt: number;
  updatedAt: number;
  result?: string;
}
```

**直接 import**，不重定义。

### 2.4 `tasks.md` 派生视图格式

```markdown
# {{teamName}} — Tasks

> Auto-generated from tasks.json. Do not edit manually — changes will be overwritten.
> Last sync: {{ISO timestamp}}

## Stats
- Total: {{n}} | Pending: {{n}} | In Progress: {{n}} | Completed: {{n}} | Failed: {{n}}

## Tasks

### ☐ T1 [pending] {{title}}
- ID: `{{uuid}}`
- Assignee: {{memberName}} or _unassigned_
- Deps: T2, T3
- Description: {{description}}

### ▶ T2 [in_progress] {{title}}
...

### ☑ T3 [completed] {{title}}
- Result: {{result}}
```

由 `TaskListMarkdownRenderer`（新增模块）负责生成；监听 `tasks.json` 变化时自动重写到 `tasks.md` 路径。

---

## 3. 关键流程

### 3.1 创建 Team（从 Chat Panel）

```
用户："创建一个 team 调研 Drizzle / Prisma / Kysely 三个 ORM"
  │
  ▼
canvas-agent.ts 调用 canvas_create_team({
  name: "ORM Research",
  leadAgentType: "claude-code",
  teammates: [
    { agentType: "codex", initialTask: "调研 Drizzle..." },
    { agentType: "codex", initialTask: "调研 Prisma..." },
    { agentType: "codex", initialTask: "调研 Kysely..." }
  ]
})
  │
  ▼
工具 handler：
  1. 生成 teamId = UUID
  2. 创建状态目录 ~/.pulse-coder/teams/{teamId}/
  3. new TaskList(stateDir) → 初始化空 tasks.json
  4. new Mailbox(stateDir)  → 初始化 mailbox 目录
  5. 在画布上创建 frame 节点 + teamMeta
  6. 在 frame 内创建 lead agent 节点（写入 spawnPrompt = team lead system prompt）
  7. 在 frame 内创建 N 个 teammate agent 节点（带 initialTask 作为 inlinePrompt）
  8. 创建 tasks.md 视图节点（filePath 指向状态目录的镜像 md 文件）
  9. 创建 edge：lead → 每个 teammate（kind: 'team-member'）
 10. 启动 tasks.json 文件 watcher，每次变化触发 markdown 重渲染
  │
  ▼
返回画布的 nodeIds 列表
```

### 3.2 Lead 协调循环（核心算法）

Lead agent 的 system prompt 指示它执行如下循环（用 bash 调 `pulse-canvas team` 子命令实现，不需要画布管它定时跑）：

```
LOOP:
  1. read tasks.json
  2. read mailbox/{leadMemberId}.json （收信）
  3. 决策：
     - 有未读消息？→ 处理（回信、新建任务、重新分配）
     - 有 unassigned 且 unblocked 的任务？→ 选择合适的 teammate，写入 assignee + 通过 mailbox 发任务通知
     - 所有任务都 completed？→ 综合输出 + 标记 team 完成 + exit loop
     - 否则：sleep 5s + 继续
  4. （可选）通过 canvas_get_team_status 查询 teammate PTY 是否还活着；死掉的 → 重启或重分配
  5. goto LOOP
```

**关键实现细节**：

- Lead 不直接调用 `canvas_send_to_agent` 给 teammate 发指令 —— **它通过 mailbox 写消息**，让 teammate 自己读。这样：
  - 即使 teammate PTY 暂时关闭，消息也不丢
  - teammate 重启后从 mailbox 自然恢复上下文
  - 与 `packages/agent-teams` 文件协议对齐
- 但**初次启动 teammate** 时，需要 lead 通过 `canvas_send_to_agent` 写入 PTY 一条引导消息（"请读 ~/.pulse-coder/teams/{teamId}/mailbox/{你的 memberId}.json 收任务"），否则 teammate CLI 不知道 mailbox 在哪
- Lead 的 sleep 用 `bash sleep 5`，避免阻塞 PTY；v1.1 可考虑加 `pulse-canvas team wait` 子命令用 `fs.watch` 阻塞到文件变化（见 §12 O1）

### 3.3 Teammate 工作循环

Teammate system prompt（通过初始 prompt 注入）：

```
你在一个 agent team 中工作。Team ID: {teamId}, Member ID: {memberId}
共享状态目录：~/.pulse-coder/teams/{teamId}/

工作流：
1. 读 mailbox/{memberId}.json 看有没有新消息
2. 读 tasks/tasks.json，找到 assignee=={memberId} && status=='in_progress' 的任务
3. 执行任务（使用 read/edit/bash 等工具）
4. 完成后：
   a. 把产出写到任务描述里指定的文件路径
   b. 调用 canvas_complete_task({ taskId, result }) 更新任务状态
   c. 给 lead 发消息："T1 完成，结果在 X"
5. 回到第 1 步等下一个任务，或在没有任务时退出
```

### 3.4 多 Team 并行（PRD F9）

每个 team 完全隔离：
- 独立 `teamId` → 独立状态目录 → 独立 TaskList / Mailbox 实例
- CLI 子命令签名都带 `teamId`，无歧义
- Agent 节点的 `teamMembership.teamId` 唯一指明归属
- 视觉差异：每个 team frame 自动分配 hash(teamId) → 颜色，header 显示 team name

### 3.5 清理 Team

```
用户右键 team frame → "Disband Team"
  │
  ▼
弹窗确认（列出会发生什么：N 个 PTY 关闭、状态目录归档）
  │
  ▼
1. 给所有 teammate mailbox 发 shutdown_request
2. 等待 5s 让 teammate 自然结束当前任务
3. 强制 kill 所有 PTY
4. 归档状态目录到 ~/.pulse-coder/teams-archive/{teamId}-{timestamp}/
5. 删除画布上的所有 team 成员节点 + tasks 视图节点
6. 删除 team frame
```

---

## 4. `pulse-canvas` CLI 扩展

现有 CLI 子命令组（`packages/canvas-cli/src/commands/`）：
`workspace / node / edge / context / install-skills`

新增子命令组：`team`（10 个子命令），实现在 `packages/canvas-cli/src/commands/team.ts`，依赖 `core/team.ts`。

### 4.1 新增子命令清单

| 子命令 | 调用方 | 用途 |
|--------|--------|------|
| `pulse-canvas team create <name>` | chat panel / 用户 | 创建新 team，分配 UUID，写状态目录 |
| `pulse-canvas team list` | 任何 agent | 按 workspace 列出 team |
| `pulse-canvas team status <teamId>` | 任何 agent | 聚合视图：成员 + 任务统计 |
| `pulse-canvas team add-member <teamId>` | chat panel / lead | 给 team 注册一个成员（关联到 canvas node） |
| `pulse-canvas team destroy <teamId>` | chat panel / 用户 | 归档状态目录到 teams-archive |
| `pulse-canvas team task create <teamId>` | lead | 包装 `TaskList.create` |
| `pulse-canvas team task list <teamId>` | 任何 agent | 包装 `TaskList.getAll/getByStatus` |
| `pulse-canvas team task claim <teamId>` | teammate | 包装 `TaskList.claim`（auto-claim 优先级见下） |
| `pulse-canvas team task complete <teamId>` | teammate | 包装 `TaskList.complete`，解锁依赖任务 |
| `pulse-canvas team msg send <teamId>` | 任何成员 | 包装 `Mailbox.send`（支持 `--to "*"` 广播） |
| `pulse-canvas team msg read <teamId>` | 任何成员 | 包装 `Mailbox.readUnread` |

> **注**：原方案中的 `canvas_create_agent`（在 team 内 spawn agent 节点）和 `canvas_send_to_agent`（写 PTY）**不在 CLI 中实现** — 前者需要写 canvas.json，留给 chat panel 的 canvas-agent 工具完成；后者需要访问 main process 的 `pty-manager`，CLI 跑在独立进程里访问不到。Lead 通过 mailbox 协调 teammate，不需要直接写 PTY。

### 4.2 关键签名（已落地）

```bash
# team-scoped: 所有需要 memberId 的命令都校验它在 team 的 config.json 里
pulse-canvas team task claim <teamId> --member-id <id> [--task-id <id>] --format json
# 返回: claimed Task | { ok: true, claimed: null }
# auto-claim 优先级（来自 TaskList 实现）:
#   1. 预分配给 me 的任务
#   2. 未分配的任务
#   3. work-stealing：从已不活跃的 teammate 那里偷（基于 isTeammateActive 回调）

pulse-canvas team msg send <teamId> --from <id> --to <id|*> --content <text> [--type message|broadcast|shutdown_request]
# from 必须是 team 成员；to 必须是成员或 "*"

pulse-canvas team task create <teamId> --member-id <id> --title <t> --description <d> [--deps a,b] [--assignee <id>]
# member-id 记录为 createdBy；deps 用 CSV
```

### 4.3 实现要点

- **TeamRuntime 缓存只在单进程内有效**：每次 `pulse-canvas` 调用都是新进程，缓存随进程死亡。跨进程一致性靠 `TaskList` 自带的 `O_EXCL` 文件锁（实测 50 retry + 20ms 间隔，已经够用）。
- **身份校验**：`hasMember(teamId, memberId)` 在每个 `--member-id` 命令的入口检查，错则 `errorOutput()` 退出 1。
- **CLI 沿用现有风格**：commander + `output()`（json/text 双格式）+ `errorOutput()`（exit 1）— 完全跟 `commands/edge.ts` 一致。
- **跨子命令依赖路径解析**：`team task create` 嵌套两层 commander，`getRootOpts` 用 `while (cur.parent)` 循环上溯找根 program，而不是硬编码 `parent.parent`。
- **不破坏现有 CLI**：注册到 `cli.ts` 末尾，原命令零改动。

### 4.4 已完成与已验证

✅ 已实现并端到端测试通过（截至 v0.2 草案）：
- create / list / status / add-member / destroy
- task create / list / claim（含 auto-claim 优先级）/ complete（含 result）
- msg send / read（含 read-once 语义）
- 跨 team 身份校验（错 teamId 拒绝，exit 1）
- 多 team 并存于同 workspace、跨 workspace 隔离
- typecheck / build 通过

---

## 5. Lead 系统提示词设计

### 5.1 注入方式

通过节点创建时的 `inlinePrompt` 字段注入。例如对 claude-code lead：

```bash
claude '<<< Lead Agent Bootstrap Prompt >>>'
```

prompt 内容（伪文本，实际放 `apps/canvas-workspace/src/main/canvas-agent/prompts/lead-agent.md`）：

```markdown
你是一个 agent team 的 Team Lead。

## 你的身份
- Team ID: {teamId}
- Your Member ID: {leadMemberId}
- Team State Dir: ~/.pulse-coder/teams/{teamId}/
- Your Teammates: [memberId-1: codex, memberId-2: codex, ...]

## 共享资源
- Tasks: ~/.pulse-coder/teams/{teamId}/tasks/tasks.json
- Your Mailbox: ~/.pulse-coder/teams/{teamId}/mailbox/{leadMemberId}.json

## 工作流（请严格遵循）
1. `bash pulse-canvas team status $PULSE_TEAM_ID` 看整体状态
2. `bash pulse-canvas team msg read $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER` 看收件箱
3. 决策（详见决策矩阵）
4. 执行决策（`pulse-canvas team task create / msg send` 等）
5. 用 `bash sleep 5` 等待
6. 回到第 1 步

## 决策矩阵
- 有 teammate 报告任务完成 → 之前 teammate 已自调 `task complete`，无需你做；只需检查依赖任务能否解锁
- 有 unassigned 任务且有空闲 teammate → `task create --assignee` 或让 teammate auto-claim
- 所有任务都 completed → 综合输出到 frame 内的 file 节点 → `msg send --to "*" --type shutdown_request` → 退出
- teammate PTY 死了但任务未完成 → `team status` 能看到任务还在 in_progress，可让其他 teammate work-steal（auto-claim 第三优先级），或人工干预

## 禁止
- 不要自己执行 teammate 的任务（即使你能做）—— 你的职责是协调
- 不要直接编辑 ~/.pulse-coder/teams/ 下的 JSON 文件 —— 一定走 CLI（有文件锁）
- 不要短间隔轮询（< 5s）—— 浪费 token，阻塞其他 agent 的文件锁竞争
```

### 5.2 环境变量注入

Lead/teammate 启动时，初始 prompt 里需要 `export` 三个变量供后续 bash 调用使用：

```bash
export PULSE_TEAM_ID=<uuid>
export PULSE_TEAM_MEMBER=<memberId>     # lead 或 teammate 自己的 memberId
export PULSE_TEAM_LEAD=<leadMemberId>   # 给 teammate 发消息回 lead 用
export PULSE_TEAM_ROLE=lead             # 或 'teammate'
```

这些环境变量被 `skills/team/SKILL.md` 文档引用 — 见 [`packages/canvas-cli/skills/team/SKILL.md`](../../../../packages/canvas-cli/skills/team/SKILL.md)。

### 5.3 跨 agent 适配

| Agent | Lead 适配 | Teammate 适配 |
|-------|----------|---------------|
| claude-code | 完整 prompt 即可，自带 todo 工具会主动用 | 同上 |
| codex | 简化 prompt（codex 不擅长长指令）；强调 mailbox/tasks.json 路径 | 同上；注意 PTY 写入需 120ms 延迟 |
| pulse-coder | 完整 prompt；引擎工具丰富，可调用更多 | 同上 |

**MVP 默认配置**：lead = claude-code 或 pulse-coder；teammates 任意。

---

## 6. UI / 视觉设计

### 6.1 Team Frame 视觉差异

| 元素 | 普通 Frame | Team Frame |
|------|-----------|-----------|
| Header label | `Untitled` | `🤝 ORM Research · 3 members · 2/5 tasks` |
| Border | 实线 | 双线 / 加粗 |
| Color | 用户选择 | hash(teamId) 自动分配，避免多 team 撞色 |
| Header 操作按钮 | 颜色选择器 | + Disband / Add Member / View Tasks |

### 6.2 Lead 节点标记

```
┌─ Agent Node Header ──────────┐
│ 👑 [Lead] codex · running    │  ← 皇冠 + Lead 标签
└──────────────────────────────┘
```

### 6.3 Teammate 节点标记

```
┌─ Agent Node Header ──────────┐
│ codex · 🏃 Working on T2     │  ← 当前任务 ID
└──────────────────────────────┘
```

### 6.4 Edge 样式

- **lead → teammate**（`kind: 'team-member'`）：细虚线，浅灰色，无箭头
- **task 依赖**（`kind: 'depends-on'`）：实线 + 三角箭头（v1.1）

### 6.5 Tasks 视图节点

普通 file 节点，但 header 上加一个 "🔄 Auto-synced" 徽标提示用户不要直接编辑。

---

## 7. 关键文件改动清单

### 7.1 已完成（v0.2 落地）

| 文件 | 改动 | 状态 |
|------|------|------|
| `apps/canvas-workspace/src/renderer/src/types.ts` | `FrameNodeData.teamMeta` + `AgentNodeData.teamMembership` | ✅ |
| `apps/canvas-workspace/package.json` | 添加 `pulse-coder-agent-teams: workspace:*` 依赖 | ✅ |
| `packages/canvas-cli/package.json` | 添加 `pulse-coder-agent-teams: workspace:*` 依赖 | ✅ |
| `packages/canvas-cli/tsconfig.json` | 加 paths 把 `pulse-coder-agent-teams` 指向 dist `.d.ts`，避免源码传染 | ✅ |
| `packages/canvas-cli/src/core/team.ts` | **新建**：TeamRuntime 缓存 + 文件协议封装 | ✅ |
| `packages/canvas-cli/src/core/index.ts` | barrel export `team.ts` | ✅ |
| `packages/canvas-cli/src/commands/team.ts` | **新建**：10 个 team 子命令 | ✅ |
| `packages/canvas-cli/src/cli.ts` | 注册 `registerTeamCommands` | ✅ |
| `packages/canvas-cli/skills/team/SKILL.md` | **新建**：教 agent 用 team 子命令的 SKILL 文档 | ✅ |

### 7.2 待做（剩余 MVP 工作）

| 文件 | 改动 | 估算 |
|------|------|------|
| `apps/canvas-workspace/src/main/canvas-agent/tools.ts` | 新增 `canvas_create_team` 工具：spawn 一个 frame + N 个 agent 节点，调 CLI 注册成员，注入环境变量 | 1d |
| `apps/canvas-workspace/src/renderer/src/components/FrameNodeBody/index.tsx` | Team frame 视觉差异化（皇冠 / 双线边框 / 进度计数） | 1d |
| `apps/canvas-workspace/src/renderer/src/components/AgentNodeBody/index.tsx` | Lead/teammate 标记 + 当前任务显示 | 0.5d |
| `apps/canvas-workspace/src/main/canvas-store.ts` | Disband team 时的级联清理（关 PTY、调 `pulse-canvas team destroy`） | 0.5d |
| `apps/canvas-workspace/src/main/team/markdown-renderer.ts` | **新建**：tasks.json → tasks.md 派生 + 文件 watcher（让画布上的 tasks-view file 节点自动刷新） | 0.5d |

**MVP 剩余工作量估计**：约 3-4 个工作日（基础设施层已完成，剩余都是 UI / 集成）

---

## 8. 阶段拆分（与 PRD §9 对齐）

### Milestone 1（MVP, 约 2-3 周）

按依赖顺序：

1. **数据模型 + 复用接入** ✅ 已完成
   - 加 `pulse-coder-agent-teams` 依赖到 canvas-workspace 和 canvas-cli
   - 扩展 `FrameNodeData` / `AgentNodeData` 类型
   - `packages/canvas-cli/src/core/team.ts` 管理 TaskList/Mailbox

2. **CLI 子命令扩展** ✅ 已完成（原计划 MCP 工具，现已转 CLI 路线）
   - `packages/canvas-cli/src/commands/team.ts` 实现 §4.1 的 10 个子命令
   - 端到端 e2e 测试通过（create/list/status/add-member/destroy + task/msg 全套）

3. **Skill 文档** ✅ 已完成
   - `packages/canvas-cli/skills/team/SKILL.md` 教 agent 用法

4. **Lead 引导 + Markdown 派生**（1 天，待做）
   - Lead system prompt 模板（已在 §5 定义，待落地为代码模板文件）
   - 实现 tasks.json → tasks.md 派生 + watcher（让画布上的 tasks-view file 节点自动刷新）

5. **画布节点改动**（2 天，待做）
   - canvas-agent 加 `canvas_create_team` 工具：spawn frame + N 个 agent 节点 + 注入环境变量 + 调 CLI 注册成员
   - Frame / Agent 节点视觉差异化

6. **集成 + Demo 1 验收**（1-2 天，待做）
   - 端到端跑 PRD §6.1 Demo 1（ORM 调研）
   - 跑多 team 并行验证（同 workspace 起两个 team）
   - 调试 cross-agent 适配（claude/codex/pulse 各自的 quirks）

### Milestone 2（约 2 周）

- Lead 主动监控（PTY 心跳检测）
- 任务依赖 UI（depends-on edges）
- Disband team 流程
- Demo 2（手动组队）

### Milestone 3（按需）

- Team 模板（research-3 / debug-5 / fullstack-4）
- Claude Code 原生 teams 协议适配
- Hooks 集成

---

## 9. 决策记录（回应 PRD §10 开放问题）

| 问题 | 决策 | 理由 |
|------|------|------|
| **Q1**：协调循环 = 事件驱动 vs 轮询？ | **MVP 用轮询（5s）+ mailbox** | 简单可靠；事件驱动需要文件 watcher 跨进程通知，复杂度溢价不值得；后续可改 |
| **Q2**：完成信号怎么传？ | **专用 CLI 子命令 `pulse-canvas team task complete`** | 比"输出标记字符串"鲁棒得多；跨 agent 一致；teammate prompt + SKILL 文档中明示 |
| **Q3**：Teammate PTY 退出后谁负责重启？ | **Lead 责任** | Lead 通过 `pulse-canvas team status` 检测；可选择重建 agent 节点（让 chat panel 介入）或让其他 teammate work-steal；用户只负责异常情况干预 |
| **Q4**：tasks.json 并发安全？ | **复用 TaskList 自带的 file lock** | `withLock(O_EXCL)` 已经处理好；不需要额外机制 |
| **Q5**：Lead 节点摆放约束？ | **不约束位置，但要求在 team frame 内** | 用户拖出 frame → 弹窗确认是否解除 lead 身份 |
| **Q6**：多 team 资源预警？ | **按"活跃 teammate 总数"算** | 单 team ≥ 6 警告（PRD 已定）；workspace 总数 ≥ 12 给二级警告 |

---

## 10. 风险与缓解（技术层面）

| 风险 | 影响 | 缓解 |
|------|------|------|
| Lead PTY 关闭后 team 进入"无主" | 高 | UI 上显式标记"Lead Offline"；提供"Reassign Lead"操作 |
| 多个 lead 实例同时启动（用户误操作多开） | 中 | `teamMeta.leadNodeId` 唯一字段；新 lead 启动时检测并提示已有 lead |
| `tasks.json` 文件锁残留（进程崩溃） | 中 | TaskList 已有 50 retry + force-remove fallback |
| Lead system prompt 太长导致 codex 截断 | 中 | 准备简化版 prompt 给 codex；MVP 默认 lead = claude/pulse |
| Mailbox 无限增长 | 低 | 加定期 truncate（保留最近 100 条）；MVP 阶段不做 |
| 跨 workspace 误用 teamId | 中 | `core/team.ts` 的 `listTeams(workspaceId)` 按 workspaceId 过滤；CLI 子命令在 `--member-id` 参数上做身份校验 |

---

## 11. 测试策略

### 11.1 单元测试

- `team-manager.ts`：teamId 隔离、并发创建
- `markdown-renderer.ts`：JSON → markdown 渲染快照
- CLI 子命令：每个命令的 happy path + 边界（teamId 不存在、memberId 错配等）

### 11.2 集成测试

- 完整生命周期：create team → spawn members → claim/complete tasks → disband
- 并发：多个 teammate 同时 claim 同一任务，只能一个成功
- 多 team：同 workspace 起 2 个 team，互不影响

### 11.3 端到端 Demo 验收

- Demo 1（ORM 调研，3 teammates 并行）
- Demo 2（手动组队，2 agents → group as team）
- 多 team 场景：调研 team + 调试 team 同时跑

### 11.4 跨 Agent 兼容矩阵

| 配置 | 必须验证 |
|------|---------|
| claude-code lead + 3 codex teammates | ✅ |
| pulse-coder lead + mixed teammates | ✅ |
| codex lead + 2 pulse teammates | ⚠️ best-effort（codex 协调能力受限） |

---

## 12. 开放技术问题（需要后续讨论）

- **O1**：Lead 周期性轮询用 `bash sleep 5` 简单但有几秒延迟。v1.1 是否加一个 `pulse-canvas team wait <teamId> [--timeout 60s]` 子命令，用 `fs.watch` 阻塞直到 tasks/mailbox 变化？
- **O2**：teammate 退出时是否自动归档其 mailbox？还是保留以便重启后接回？
- **O3**：UI 上是否需要一个全局"Team Inspector"侧边栏，列出所有 team 状态？还是完全靠画布上的 frame 视觉？倾向后者，但需要用户测试验证。
- **O4**：派生的 `tasks.md` 路径放哪？方案 A：状态目录内（`~/.pulse-coder/teams/{teamId}/tasks.md`）；方案 B：workspace notes 目录内（与其他 file 节点一致）。倾向 A，避免污染 workspace 文件。
- **O5**：第一版是否需要 Hook 集成？倾向不要，留到 Milestone 3。

---

## 13. 附录

### 13.1 与 `packages/agent-teams` 的接口边界

**复用的 API**（在 `packages/canvas-cli/src/core/team.ts`）：

```ts
import { TaskList, Mailbox } from 'pulse-coder-agent-teams';
// 类型也来自同一包（透传给 commands/team.ts）：
//   Task, TeamMessage, TaskStatus, MessageType
```

**不使用的导出**（自建 CLI 版替代）：
- `Team` / `TeamLead` / `Teammate` 类（强依赖 in-process Engine 实例）
- `planTeam` / `buildTeammateOptionsFromPlan`（输出 Engine 配置，画布不需要）
- `InProcessDisplay`（终端 UI，画布本身就是显示层）

**特殊注意**：`packages/canvas-cli/tsconfig.json` 把 `pulse-coder-agent-teams` path-alias 到 `dist/index.d.ts`，避免根 tsconfig 的"指向源码"路径把 engine/orchestrator 源码传染进 canvas-cli 的 typecheck 范围。

### 13.2 状态目录布局对比

```
~/.pulse-coder/teams/
└── {teamId}/                  ← canvas 用
    ├── config.json            ← canvas 自建（与 packages/agent-teams 的 PersistedTeamConfig schema 对齐）
    ├── tasks/
    │   ├── tasks.json         ← 复用 TaskList 写入
    │   ├── tasks.lock         ← TaskList 文件锁
    │   └── tasks.md           ← canvas 自建派生视图
    └── mailbox/
        ├── {leadMemberId}.json    ← 复用 Mailbox
        ├── {teammate1MemberId}.json
        └── _broadcast.json
```

### 13.3 命名约定

- `teamId`：UUID（如 `550e8400-e29b-41d4-a716-446655440000`）
- `memberId`：`{teamId}-m{n}` 形式，便于人工 debug（如 `550e...440000-m1`）
- `taskId`：UUID（由 TaskList 自分配）
- 状态目录名 = `teamId` 全字符（含 dash），与 `packages/agent-teams` 的 `name` 字段对齐

# Agent Teams on Canvas — 产品需求文档 (PRD)

**Status**: Draft v0.1
**Owner**: Jasper
**Last updated**: 2026-04-25

---

## 1. 背景与动机

### 1.1 问题描述

当前 canvas-workspace 已经支持在画布上创建多个 agent 节点（claude-code / codex / pulse-coder），每个节点是独立的 PTY 进程。但这些 agent 之间是**完全孤立**的：

- 没有共享上下文 — 每个 agent 只知道自己的初始 prompt
- 没有任务协调 — 用户必须手动把任务拆给每个 agent
- 没有进度同步 — 每个 agent 独立结束，结果分散在各自终端
- 没有协作语义 — 画布只是"多个 agent 的收纳盒"，没有体现它们应该一起做事

与此同时，Claude Code 在 v2.1.32 引入了原生的 **Agent Teams** 概念：team lead 协调 teammates、共享任务列表、agent 间互相通信。但它有两个限制：
1. **只覆盖 claude-code**，不能协调跨厂商的 agent
2. **没有可视化** — team 拓扑、任务流、agent 状态全在终端里，不直观

### 1.2 机会

canvas-workspace 已经具备的基础设施恰好覆盖了 Agent Teams 缺失的可视化层：

- **Frame 节点** + 几何归属算法 → 天然的"团队边界"
- **Edge 节点** + 语义标签 → 天然的"任务流/依赖关系"
- **MCP server** 已自动注册到 claude-code 和 codex → agent 天生有画布操作能力
- **canvas-agent**（chat panel）→ 现成的高层指挥入口

把这些组合起来，canvas-workspace 可以成为**第一个跨 agent 厂商、可视化的 agent 协作平台**。

### 1.3 目标用户

主要面向：
- **AI 工程师 / 资深开发者** — 已经熟悉 claude-code / codex / pulse-coder 单 agent 工作流，想要扩展到多 agent 协作
- **画布工作流爱好者** — 习惯 Heptabase / FigJam 这种空间组织思维，希望 agent 协作也能"看得见"

不针对：
- 完全新手（多 agent 协作本身需要一定经验门槛）
- CI/CD / 自动化场景（这是交互式画布工具，不是流水线）

---

## 2. 用户故事

### 2.1 核心故事

**S1：研究并对比方案**
> 我在做技术选型，要在三个 ORM 库之间选一个。我把 PRD 拖进画布，让 canvas agent 创建一个 team：3 个 teammate 各自调研一个库（Drizzle / Prisma / Kysely），最后由 lead 综合输出对比报告。我可以在画布上看到每个 teammate 的进展，需要时直接干预某一个。

**S2：跨层协调实现新功能**
> 我要给应用加"邀请同事"功能。我创建一个 team，包含 1 个 lead + 3 个 teammate（前端 / 后端 / 测试）。Lead 拆分任务到 tasks.md，每个 teammate 认领自己专长的任务。前后端 teammate 边做边在画布上互相参考对方的输出，测试 teammate 在两者完成后跟进。

**S3：并行调试**
> 一个偶发 bug 不知道根因。我让 canvas agent 起 4 个 teammate，每人测试一个假设（数据库 / 网络 / 缓存 / 时序）。它们各自在终端里跑实验，把结论写进共享 tasks.md，最后由 lead 综合判断哪个假设成立。

**S4：跨 agent 协作（独有价值）**
> 我用 claude-code 做架构设计，用 codex 写实际代码（不同模型擅长不同事）。在画布上把它们放进一个 team frame：claude-code 作为 lead 出方案，codex 作为 teammate 实现。Lead 通过共享文件传递设计文档给 codex。

### 2.2 反向故事（明确不做）

**N1：完全自主长跑**
> 我不希望"创建 team 然后离开几小时回来看结果"。这版本明确要求人在场。

**N2：team 之间互相调用**
> 不支持"team A 主动 RPC 调用 team B"的程序化调度。多个 team 可以共存于同一画布，但它们之间不直接通信 — 用户作为人类协调者在团队间传递信息（或借助共享 file 节点）。

**N3：跨 workspace team**
> Team 的成员必须在同一个 canvas workspace 内。

### 2.3 多 Team 并行（关键约束）

**单个 workspace 必须支持任意数量的 team 同时存在与并行运行。**

这是画布产品的核心特性 — 用户会很自然地在同一个 workspace 里组织多个 team，例如：

- 一个 team 在做"前端调研"，另一个 team 在做"后端调研"，互不打扰但都对当前项目有贡献
- 一个长跑的"PRD 讨论 team"挂在画布角落，旁边临时起一个"快速调试 team"
- 主线工作 team 之外，单独建一个"实验沙盒 team" 跑高风险尝试

**派生需求**（影响后续设计）：

- **每个 team 有独立身份**：`teamMeta` 自带稳定 `teamId`，不能假设"画布上只有一个 team"
- **每个 team 有独立 tasks.md**：放在各自 team frame 内，不共用全局任务列表
- **每个 team 有独立的 lead 协调循环**：多个 lead agent 可同时在跑，互不干扰
- **MCP 工具必须 team 范围化**：`canvas_list_agents` 等工具应支持按 `teamId` 过滤，避免一个 team 的 lead 看到/操作另一个 team 的成员
- **Agent 节点最多归属一个 team**：通过 frame 的几何归属算法天然保证（最近的 team frame 优先）；交叉摆放需要给出明确归属规则
- **视觉差异化要可区分多个 team**：不同 team 用不同 frame 颜色 / 不同 lead icon 颜色，避免画布上多个 team 视觉混淆

---

## 3. 范围

### 3.1 In Scope（MVP 必做）

| ID | 功能 | 说明 |
|----|------|------|
| F1 | Team Frame | Frame 节点扩展 `teamMeta`，标识为 team 容器 |
| F2 | Lead Agent | 一个普通 agent 节点被指定为 lead，使用专门的 system prompt |
| F3 | 共享任务板 | Team frame 内的 `tasks.md` 文件节点，所有成员读写 |
| F4 | 三种 agent 互通 | claude-code / codex / pulse-coder 都能担任 lead 或 teammate |
| F5 | MCP 工具扩展 | 新增 `canvas_create_agent` / `canvas_send_to_agent` / `canvas_list_agents` 等 |
| F6 | 视觉化拓扑 | Team frame header 显示 team 名 / 成员数；lead 节点有专属标记；分配关系用 edge 表达 |
| F7 | 从 Chat Panel 创建 team | canvas agent 提供 `canvas_create_team` 工具，一句话起一个 team |
| F8 | 状态可观测 | 用户在画布上能看到：哪些 teammate 在跑、哪些任务在进行/完成 |
| F9 | 多 team 并行 & 隔离 | 同一 workspace 多个 team 并存；MCP 工具按 `teamId` 范围化；agent 只属一个 team |

### 3.2 Should Have（优先级高，可推迟到 v1.1）

| ID | 功能 | 说明 |
|----|------|------|
| F10 | Lead 主动监控 | Lead agent 周期性读取 teammate 输出，判断完成 / 卡住 / 需要干预 |
| F11 | 任务依赖 | tasks.md 支持 `blockedBy` 字段，未解锁的任务不能被认领 |
| F12 | 优雅清理 | "解散 team" 操作：关闭所有 PTY、归档对话、清理临时文件 |
| F13 | Team 模板 | 预定义几种常见 team 结构（research-3 / debug-5 / fullstack-4）一键创建 |

### 3.3 Could Have（v2+）

- C1：Claude Code 原生 agent teams 协议集成（读 `~/.claude/teams/{name}/config.json` 反射到画布）
- C2：跨 workspace team
- C3：Team 嵌套（大 team 内含子 team，小 team 各自有 lead）
- C4：Hooks 集成（TaskCreated / TaskCompleted / TeammateIdle）
- C5：Team 录制回放（导出整个协作过程为可回放的 timeline）

### 3.4 Out of Scope（明确不做）

- ❌ Peer-to-peer 直接消息（teammate 之间不直接 IPC，统一通过 lead 或共享文件）
- ❌ 自动 agent 选型（不会"AI 帮你决定 lead 用哪种 agent"）
- ❌ 持久化跨会话的 team 状态（关闭 workspace 后 team 终止）
- ❌ 移动端支持

---

## 4. 功能需求详述

### 4.1 创建 Team

**触发方式**：

1. **从 Chat Panel**（推荐入口）
   - 用户对 canvas agent 说："创建一个 team 来调研三个 ORM"
   - canvas agent 调用 `canvas_create_team` 工具
   - 自动在画布上创建：1 个 team frame + 1 个 lead agent + N 个 teammate + 1 个 tasks.md + 必要的 edge

2. **从画布右键菜单**（次要入口）
   - 框选若干 agent 节点 → 右键 "Group as Team"
   - 自动外套 team frame，提示用户指定 lead

3. **手动**（高级用户）
   - 用户自己创建 frame，在 inspector 里勾选 "This is a team"
   - 拖 agent 节点进 frame 自动成为成员

**默认行为**：
- 新 team 自动生成名字：`Team-{timestamp}` 或基于任务关键词
- 默认创建一个空的 `tasks.md` 在 team frame 内
- 默认 lead = 第一个加入的 agent；可手动改

### 4.2 任务分配与执行

**Tasks.md 格式**（约定，非强 schema）：

```markdown
# Team Tasks

## ☐ T1: 调研 Drizzle ORM
- assignee: codex-1
- status: pending
- output: notes/drizzle.md

## ☐ T2: 调研 Prisma ORM
- assignee: claude-1
- status: in_progress
- output: notes/prisma.md
- blockedBy: []

## ☑ T3: 综合对比
- assignee: lead
- status: completed
- blockedBy: [T1, T2]
```

**Lead 的协调循环**（关键流程）：
1. 读 tasks.md
2. 找出 unassigned 任务，根据 teammate 类型/能力分配（写回 tasks.md + 通过 `canvas_send_to_agent` 通知 teammate）
3. 周期性轮询 teammate 状态（PTY 输出 + 节点 status 字段）
4. 任务完成 → 更新 tasks.md → 解锁依赖任务
5. 全部完成 → 综合输出，停止循环

**Teammate 的执行模式**：
- 收到 lead 通过 `canvas_send_to_agent` 发来的初始 prompt
- prompt 中包含：任务 ID、任务描述、相关文件路径、约定的产出位置
- 完成后写产出文件 + 在 PTY 中输出标记（如 `=== TASK T1 DONE ===`）便于 lead 解析

### 4.3 跨 Agent 兼容

| Agent | Lead 角色 | Teammate 角色 | 备注 |
|-------|-----------|--------------|------|
| claude-code | ✅ 完整支持 | ✅ 完整支持 | 自带 todo 工具，能很好地处理 tasks.md |
| codex | ⚠️ 受限支持 | ✅ 完整支持 | TUI 输入需 120ms 延迟（已有处理）;监控其状态较难 |
| pulse-coder | ✅ 完整支持 | ✅ 完整支持 | 内部产品，可针对性优化 |

**推荐组合**：
- 默认 lead = claude-code 或 pulse-coder（更可靠的协调能力）
- teammate 可任意混用

### 4.4 可观测性

**画布上必须能看到**：
- Team frame：队名、成员数、整体进度（X/Y 任务完成）
- Lead 节点：皇冠图标 / 不同边框颜色
- Teammate 节点：当前任务 ID 显示在 header
- Edge：lead → teammate 的分配关系（kind: `assigned`），任务依赖关系（kind: `depends-on`）
- Tasks.md：作为普通 file 节点直接展示，实时刷新

**不需要新增**：
- 单独的"team 仪表盘" — 画布本身就是仪表盘
- 进度条小部件 — frame label 文字够用

### 4.5 错误处理

| 场景 | 行为 |
|------|------|
| Teammate PTY 退出 | 节点 status → `error`，lead 收到通知（通过 `canvas_list_agents` 轮询发现），决定重启或重分配 |
| Lead 自身崩溃 | Team frame 进入"无主"状态，画布上提示用户接管或选新 lead |
| MCP server 不可达 | Agent 退化为孤立节点，team 协调暂停；恢复后 lead 重新读 tasks.md 继续 |
| tasks.md 被并发写坏 | 走 canvas-store 已有的 `.bak` 备份机制；agent 操作失败时让 lead 重试 |
| Agent 误删 team frame | 删除前必须二次确认（UI 弹窗）；删除后所有成员 PTY 关闭 |

---

## 5. 非功能需求

### 5.1 性能

- **创建 team 延迟**：< 3 秒（不算 agent 自身启动时间）
- **MCP 工具调用延迟**：单次 < 500ms
- **画布渲染**：team frame + 10 个 teammate 同时活跃时不卡顿（≥ 30 FPS）

### 5.2 资源占用

- 单 team 通常 3-5 个 teammate（参考 Claude docs 推荐）
- 每个 teammate 是一个独立的 CLI 进程 + PTY，约 100-300 MB 内存
- 用户应能在画布上看到资源占用提示（成员数 ≥ 6 时给警告）

### 5.3 可观测性 / 调试

- 所有 MCP 工具调用记录到 main process 日志，带 team_id / node_id
- Lead agent 的协调决策（分配/重分配）写入 team frame 关联的 `team-log.md`（可选，便于事后复盘）

### 5.4 兼容性

- 不破坏现有 frame 节点行为：没有 `teamMeta` 的 frame 还是普通分组
- 不破坏现有 agent 节点：未加入 team 的 agent 还是单独运行
- canvas.json schema 向前兼容：旧版本读到带 `teamMeta` 的 frame 时降级为普通 frame

---

## 6. 成功标准

### 6.1 验收 Demo

**Demo 1：调研对比**（最小可行 demo）
1. 用户在 chat panel 输入："创建一个 team 调研 Drizzle / Prisma / Kysely 三个 ORM，最后给我对比报告"
2. 画布上自动出现：team frame "ORM Research" + 1 个 lead (claude-code) + 3 个 teammate (codex × 3) + tasks.md
3. 3 个 teammate 并行跑调研，PTY 上能看见各自进度
4. 任务全部完成后，lead 在 frame 内创建一个 `report.md` 文件节点
5. 用户在画布上一眼看到整个流程，可点开任一 teammate terminal 看细节

**Demo 2：手动组队**
1. 用户已经手动开了 2 个 agent 节点在画布上
2. 框选 → 右键 "Group as Team"
3. 弹窗选择哪个是 lead
4. team frame 自动生成包裹两个节点
5. 用户对 lead 节点直接发消息，lead 开始协调另一个 teammate

### 6.2 量化指标

- ✅ 上述两个 demo 用户能在 5 分钟内独立完成（无需文档辅助）
- ✅ 三种 agent 类型都至少有一种 lead 配置 + 一种 teammate 配置可工作
- ✅ Team frame 在画布上的视觉差异化让用户一眼能区分 vs 普通 frame
- ✅ 关闭并重新打开 workspace，team 拓扑（frame + 成员归属）能正确恢复（PTY 不强求恢复）

### 6.3 反指标（要避免）

- ❌ 用户必须先读文档才能开始用 → 失败
- ❌ Lead agent 经常 hang 住不前进 → 失败
- ❌ team 创建后用户找不到该看哪里 → 失败（说明视觉表达不够）

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解策略 |
|------|------|---------|
| 跨 agent 行为差异（输出格式、状态信号）让 lead 难以可靠监控 | 高 | MVP 先约定标记协议（`=== TASK X DONE ===`），后续再考虑更鲁棒的方案 |
| Token 成本爆炸（多个 teammate 并行） | 中 | UI 显示成员数预警；文档教育用户 3-5 人为佳 |
| Lead agent 决策失误浪费 teammate 工作 | 中 | 强制人在场；用户可随时干预任一节点 |
| MCP server 单点故障 | 中 | 已有 health check；agent 失联时画面给出明确提示 |
| 用户混淆 team frame 和普通 frame | 低 | 显著的视觉差异（皇冠图标 + 特殊边框 + label 前缀） |

---

---

## 8. 复用策略（与 `packages/` 的关系）

仓库里已有 `packages/agent-teams`（约 2300 行），其类型与目录约定与 Claude Code Agent Teams 文档高度对齐。但其默认假设 **teammate = in-process `pulse-coder-engine` 实例**，与本项目"画布上跑真实 claude/codex/pulse-coder CLI 进程"的目标不一致。

经过权衡，本项目采取 **部分复用** 策略：

### 8.1 明确复用（不重造）

| 复用对象 | 来源 | 复用理由 |
|---------|------|---------|
| `TaskList` 类 | `packages/agent-teams/src/task-list.ts` | 纯文件协议（JSON），语言/进程无关；自带 work-stealing 守卫与并发安全；任务依赖 / hooks 已实现 |
| `Mailbox` 类 | `packages/agent-teams/src/mailbox.ts` | 纯文件协议，agent 间消息队列；CLI 进程也可读写 |
| 状态目录约定 | `~/.pulse-coder/teams/{name}/` | 与 `packages/agent-teams` 共用同一目录结构（`config.json` / `tasks/` / `mailbox/`），未来引入 in-process teammate 可平滑共存 |
| 类型定义 | `Task` / `TaskStatus` / `TeamMessage` / `TeamHooks` 等 | 直接 import；避免双份类型 |

### 8.2 不复用（自建画布层）

| 不复用对象 | 原因 | 替代方案 |
|-----------|------|---------|
| `Team` 类 | 强依赖 in-process Teammate 实例 | 自建 `CanvasTeam`：以 team frame 为载体，成员 = 画布 agent 节点 |
| `TeamLead` 类 | 假设 Lead 是 Engine loop 内的特定 agent | Lead 是画布上的一个普通 agent 节点（claude-code / pulse-coder），通过 system prompt 约定其角色 |
| `Teammate` 类 | 是 Engine 实例的封装 | Teammate 是画布上的 PTY agent 节点；通过现有 `pty-manager` + `canvas_send_to_agent` 沟通 |
| `planner.ts` | 输出的是 `TeammateOptions[]`（Engine 配置） | 在 canvas-agent 工具层重新实现，输出"画布上要创建哪些 agent 节点"的指令 |
| `display/in-process.ts` | 终端 UI（Shift+Down 切换） | 不需要 — 画布本身就是显示层 |

### 8.3 长期演进（v2+）

未来可在画布上引入 **第二种 teammate 类型** —— "Engine Teammate"：
- 不开 PTY，直接在 main process 内跑 `Engine` 实例
- 资源更轻、状态更可观测、可使用更多 engine 工具
- 与 PTY teammate 共存于同一 team frame
- 两种 teammate 类型走同一份 `TaskList` / `Mailbox` 协议，对 Lead 透明

这样既守住了 MVP 的核心价值（画布上跑真实 CLI），又为长期能力扩展留了无缝路径。

### 8.4 对实现工作量的影响

| 模块 | 自建（不复用）成本 | 部分复用后的实际成本 |
|------|-------------------|---------------------|
| 任务列表（依赖图、work stealing、并发） | ~3-5 天 | 0（直接 import） |
| 消息队列（持久化、未读标记） | ~2 天 | 0（直接 import） |
| 类型定义维护 | 持续小成本 | 0 |
| Team 容器 / Lead 协调循环（PTY 编排） | 必须自建 | 必须自建（不变） |
| CLI 子命令暴露（`pulse-canvas team ...`） | 必须自建 | 必须自建（不变） |
| 视觉化 / Frame 集成 | 必须自建 | 必须自建（不变） |

**净收益**：节省 ~5-7 天底层基础设施工作，把精力集中在"画布特有"的部分。

### 8.5 暴露给 agent 的方式

复用的 `TaskList` / `Mailbox` 是 **类**，需要在 Node.js 进程里实例化才能用。Agent 是独立 CLI 进程（claude / codex / pulse-coder），不能直接 `import`。

中间通过 `pulse-canvas team` 子命令组桥接：
- `packages/canvas-cli/src/core/team.ts` 在 CLI 进程内 `import { TaskList, Mailbox } from 'pulse-coder-agent-teams'`
- `packages/canvas-cli/src/commands/team.ts` 暴露为子命令
- Agent 通过 bash 工具调 `pulse-canvas team task claim ...`，每次是新的短命进程
- 跨进程一致性靠 `TaskList` 自带的 `O_EXCL` 文件锁

技术细节见 `tech-design.md` §4。

---

## 9. 阶段拆分

### Milestone 1: MVP（2-3 周）
- F1 Team Frame 数据模型
- F2 Lead Agent system prompt
- F3 tasks.md 约定
- F4 三种 agent 兼容（基础场景）
- F5 MCP 工具扩展（核心 3 个）
- F6 基础视觉差异化
- F7 Chat Panel 创建 team 入口
- F8 基础状态展示
- F9 多 team 并行 & 隔离
- 通过 Demo 1（包含同 workspace 起两个 team 的轻量验证）

### Milestone 2: 完整体验（2 周）
- F10 Lead 主动监控
- F11 任务依赖
- F12 优雅清理
- 完成 Demo 2
- 完善错误处理 / 边界情况

### Milestone 3: 进阶（按需）
- F13 Team 模板
- C1 Claude 原生 teams 协议集成
- C4 Hooks 集成

---

## 10. 开放问题

需要在技术方案阶段或后续讨论中澄清：

- **Q1**：lead 的协调循环是"事件驱动"还是"轮询"？事件驱动需要 PTY 输出解析，轮询简单但有延迟。
- **Q2**：teammate 完成任务的信号怎么传？标记字符串容易误判，专用 MCP 工具（teammate 主动调）更可靠但需要 agent 配合。
- **Q3**：`canvas_send_to_agent` 要求目标节点 PTY 还活着。当 lead 想让一个已退出的 teammate 接新任务时，需要"重启 agent"语义 — 是 lead 的责任还是用户的？
- **Q4**：tasks.md 被多个 agent 同时编辑的并发安全 — 依赖 canvas-store 现有的原子写已经够了吗？还是需要更明确的 lock？
- **Q5**：Team frame 是否应该限制 lead 节点的位置（必须在 frame 内的固定区域）？还是让用户自由摆放？
- **Q6**：多 team 并行时，画布层面是否需要给资源占用预警？例如 3 个 team × 4 个 teammate = 12 个 CLI 进程。是否设软上限（如 ≥ 10 个活跃 teammate 时给提示），还是只看单 team 的 6+ 阈值？

---

## 11. 附录

### 11.1 术语表

- **Team Frame**：带有 `teamMeta` 字段的 frame 节点，作为 team 的可视化容器
- **Lead Agent**：team 中负责协调的 agent 节点，由 `teamMeta.leadNodeId` 指定
- **Teammate**：team frame 内除 lead 外的 agent 节点
- **Tasks.md**：team frame 内约定命名的 markdown 文件节点，作为共享任务板
- **MCP Tools**：通过 `localhost:3333/mcp` 暴露给 agent 的画布操作工具集

### 11.2 参考资料

- Claude Code Agent Teams 官方文档（已存档至 `docs.md`）
- canvas-workspace 现有架构：`apps/canvas-workspace/src/main/canvas-agent/`、`mcp-server.ts`
- pulse-coder-orchestrator 包：作为 engine 层 multi-agent 协调的对照参考
- **被复用的底层包**：`packages/agent-teams`（`TaskList` / `Mailbox` / 类型定义）— 详见 §8

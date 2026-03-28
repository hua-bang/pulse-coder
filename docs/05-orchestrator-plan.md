# Orchestrator 编排层计划

## 背景

当前 `agent-teams-plugin` 作为 engine 内置插件实现了基础的多 agent 协作能力，但存在以下限制：

- 编排逻辑耦合在 engine 层，职责边界不清晰
- 无法管理多个 Engine 实例的生命周期
- 不同 agent 无法使用不同模型/工具集
- remote-server / CLI / canvas-workspace 无法共用编排能力

长期目标是将编排逻辑提升为独立层，engine 回归"单 agent 执行器"的职责。

---

## 当前 agent-teams 现状（已完成）

### 能力
- DAG 任务图执行（`scheduler.ts`）
- 角色路由：`auto`（关键词）/ `all`（全角色）/ `plan`（LLM 动态规划）
- 并行执行：`reviewer` / `writer` / `tester` 在 `executor` 完成后并行
- Node 粒度 `instruction` 字段，支持差异化 prompt
- Artifact Store：节点产物写入本地文件，下游节点读取

### 已知局限
- 所有 agent 共用同一 engine 实例（同一模型/工具集）
- artifact 无 cleanup 逻辑
- 聚合策略只有 `concat`，缺少 `last` 等策略
- 整体仍在 engine 层，是临时方案

---

## 路线规划

### Phase 1：`packages/orchestrator`（核心编排层）✅

**目标**：从 engine 层解耦，成为独立 package，CLI / remote-server / canvas-workspace 均可接入。

核心职责：
- 管理多个 Engine 实例的生命周期
- 持有 TaskGraph 执行状态
- 跨 agent artifact 共享（升级现有 artifact-store）
- 统一执行状态事件流（`pending` / `running` / `success` / `failed`）

主要迁移内容（从 agent-teams-plugin 搬过来，去掉 EnginePluginContext 依赖）：
- `scheduler.ts` → 依赖 `AgentRunner` 接口而非 engine context
- `graph.ts` / `planner.ts` / `artifact-store.ts` 基本可直接复用
- `EngineAgentRunner` adapter 连接 engine 工具系统

补充能力：
- 每个 TaskNode 可指定独立的模型 / system prompt / 工具集
- artifact cleanup（按 runId TTL 清理）
- 聚合策略扩展：`concat` / `last` / `summary`（LLM 汇总）

### Phase 2：remote-server / CLI 接入

**目标**：将 `agent-teams-plugin` 降级为 thin adapter，CLI/remote-server 直接驱动 orchestrator，
绕过 LLM tool 调用，实现中间过程可见。

#### 执行模式切换

team 模式通过**模式命令**触发，而非 LLM 工具调用：

```
/team <task>              → 直接走 orchestrator，实时输出节点进度
/team --route=plan <task> → LLM 动态规划 graph 再执行
普通对话                   → 单 engine 模式（默认）
```

工具调用模式（现有）保留作为 LLM 自主触发的备用路径。

#### 中间过程可见

CLI 监听 orchestrator logger 事件，实时打印节点状态：

```
[orchestrator] Starting: research (researcher)
[orchestrator] ✓ research completed (12.3s)
[orchestrator] Starting: execute (executor)
[orchestrator] Starting: review (reviewer)   ← 并行
[orchestrator] ✓ review completed (8.1s)
[orchestrator] ✓ execute completed (21.4s)
```

remote-server 则通过 Feishu/Discord 推送每个节点进度消息。

#### Team 任务的会话生命周期

team 任务不是一次性调用，而是有状态的多轮会话：

```
1. 规划阶段（多轮澄清）
   用户发起 /team 任务
   → orchestrator 通过多轮对话澄清目标、范围、约束
   → 逐步完善 TaskGraph

2. 确认阶段
   → 展示生成的 TaskGraph 让用户 review
   → 用户确认或调整后再执行

3. 执行阶段
   → 执行 TaskGraph，实时推送进度
   → 某节点遇到歧义时暂停，反问用户后继续

4. 续跑能力
   → 会话状态持久化
   → 中断后可从断点恢复
```

对应 orchestrator 需要补充的能力：
- `OrchestratorSession`：持有会话状态（规划/确认/执行/暂停）
- 与现有 `clarification-queue` 对齐，提升到编排层
- 执行状态持久化（runId + 节点状态快照）

#### 会话模型与 dispatcher 的冲突

> **重要约束**：现有 dispatcher 基于"一条消息 → 一次完整 run → 结束"的模型，
> `platformKey` 锁在 run 期间，run 完立即释放。
> team 会话横跨多条消息，与这个模型天然冲突：
>
> ```
> 现在：  消息1 → run → 结束
>               消息2 → run → 结束
>
> team：  消息1 → session 开始（规划）
>               消息2 → 路由到 session（确认）
>               消息3 → 路由到 session（执行中反问）
>               消息4 → session 结束
> ```
>
> 支持完整会话生命周期需要改造 dispatcher 路由逻辑，增加
> `hasActiveSession(platformKey)` 判断，将消息转发给已有 session 而非新开 agent run。
> 这是改造难度最高的部分，放在完整版实现。

#### 最小可行版本（Phase 2 第一步）

跳过多轮澄清和执行中反问，先只做"一次性执行"：

```
/team <task>
  → 直接调 orchestrator.run()（无多轮澄清）
  → 实时打印节点进度
  → 返回最终结果
```

dispatcher 完全不需要改造，session 概念暂不引入。
等基础版稳定后，再迭代引入 OrchestratorSession 支持多轮交互。

### Phase 3：`apps/canvas-workspace` 可视化层

**目标**：将 TaskGraph 映射为 Canvas 上的节点 + 边，支持可视化编排与实时执行监控。

新增节点类型：
- **Agent 节点**：显示角色名、运行状态、产物预览
- **连线/边**：表达 DAG 依赖关系

交互流程：
1. 用户在 Canvas 上拖拽 Agent 节点、连线定义依赖
2. 点击执行 → 调用 orchestrator
3. 节点状态实时更新（颜色/进度指示）
4. 节点产物可直接在 Canvas 上预览（File 节点联动）

与 engine 通信方案：
- 优先通过 remote-server HTTP API
- 或在 Electron main process 直接引入 orchestrator package

---

## 依赖关系

```
packages/engine          ← 单 agent 执行器，保持轻量
packages/orchestrator    ← 多 agent 编排，依赖 engine
apps/remote-server       ← 接入 orchestrator（Phase 2）
packages/cli             ← 接入 orchestrator（Phase 2）
apps/canvas-workspace    ← 可视化层，接入 orchestrator（Phase 3）
```

---

## 近期待办

- [x] packages/orchestrator 骨架搭建
- [x] AgentRunner 接口 + EngineAgentRunner adapter
- [x] 核心模块迁移（scheduler/graph/router/planner/artifact-store/aggregator）
- [x] artifact cleanup 方法
- [x] 聚合策略 `last`
- [ ] agent-teams-plugin 改为 thin adapter（调用 orchestrator）
- [ ] CLI 新增 `/team` 模式命令，接入 orchestrator
- [ ] OrchestratorSession：会话生命周期管理（规划/确认/执行/暂停）
- [ ] 执行状态持久化与断点续跑
- [ ] remote-server 节点进度推送（Feishu/Discord）
- [ ] canvas-workspace 新增连线/边基础能力
- [ ] canvas-workspace 新增 Agent 节点类型

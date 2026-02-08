# 文档二：业界 Agent Loop 实现分析

> 对比三个开源项目：**OpenCode**、**pi-mono**、**Codex**

## 1. 架构总览对比

| 维度 | OpenCode | pi-mono | Codex |
|------|----------|---------|-------|
| **语言** | TypeScript (Bun) | TypeScript | Rust (核心) + TS SDK |
| **LLM SDK** | Vercel AI SDK | 自研 `pi-ai` 多 provider 抽象 | 自研 HTTP/WebSocket 客户端 |
| **Loop 模型** | `while` 循环 + 三态信号 | 双层嵌套循环（inner/outer） | Actor 模型 + Tokio 异步任务 |
| **工具执行** | SDK 回调 | 顺序执行 + steering 中断 | 并行 Tokio 任务 |
| **上下文管理** | 自动 compaction | `transformContext` 回调 | auto-compaction + truncation |
| **流式输出** | 完整 streaming pipeline | EventStream async iterable | SSE/WebSocket streaming |
| **终止判断** | `finishReason` 信号 | `stopReason` + no tool calls | `needs_follow_up` 标志 |
| **中断机制** | AbortController | AbortSignal + steering queue | CancellationToken |

## 2. OpenCode：最完整的 TypeScript 参考实现

### 2.1 三层架构

```
SessionPrompt（编排层）
    │ → 管理 loop 生命周期、sub-agent、compaction
    ▼
SessionProcessor（流处理层）
    │ → 消费 LLM stream，发送 tool 执行，处理事件
    ▼
LLM（provider 抽象层）
    │ → Vercel AI SDK streamText()，多 provider 支持
    ▼
Provider（模型注册 + SDK 适配）
```

### 2.2 核心 Loop — `SessionPrompt.loop()`

```
1. 设置 session 状态为 "busy"
2. 加载消息历史（根据 compaction 边界过滤）
3. 找到 lastUser / lastAssistant / lastFinished 消息
4. 检查终止条件：
   - 如果 lastAssistant 的 finishReason 不是 tool-call → 退出循环
5. 处理 pending subtask（子 agent 委派）
6. 处理 pending compaction（上下文溢出）
7. 检测上下文溢出并触发 auto-compaction
8. 正常处理：创建 assistant 消息 → 解析 tools → 调用 processor
9. 根据 processor 结果：
   - "stop" → break
   - "compact" → 创建 compaction → continue
   - "continue" → continue
```

**关键设计**：processor 返回三态信号（`continue` / `stop` / `compact`），将流处理层的判断和编排层的控制完全解耦。

### 2.3 终止判断

```typescript
// 不需要额外 LLM 调用，直接看模型的 finishReason
if (lastAssistant.finishReason !== 'tool-call') {
  // 模型没有请求调用工具 → 任务完成
  break;
}
```

**核心差异**：OpenCode 靠模型的 `finishReason` 来判断，不需要额外 LLM 调用。

### 2.4 Doom Loop 检测

```typescript
// 检查最近 3 次工具调用
const DOOM_LOOP_THRESHOLD = 3;
if (lastThree.every(p =>
  p.tool === value.toolName &&
  JSON.stringify(p.state.input) === JSON.stringify(value.input)
)) {
  // 检测到死循环，请求用户介入
  await PermissionNext.ask({ permission: "doom_loop" });
}
```

### 2.5 上下文管理 — Compaction

```
Token 超限 → 创建 CompactionPart → compaction agent 总结对话
                                  → 后续只加载 compaction 点之后的消息
                                  → 定期 prune 旧 tool outputs
```

- 保护最近 40K tokens 的工具输出
- 超过 20K tokens 的旧输出被清除
- compaction agent 是一个专用的隐藏 agent

### 2.6 Step 限制

```typescript
// agent 可以定义最大步数
if (steps >= agent.steps) {
  // 注入 MAX_STEPS 文本信号
  // 告诉模型不要再调用工具，直接输出结果
}
```

### 2.7 重试机制

```typescript
// 指数退避，从 2s 开始翻倍，遵循 retry-after header，最大 30s
catch (err) {
  if (SessionRetry.retryable(err)) {
    session.status = "retry";
    await sleep(backoff);  // 2s, 4s, 8s...
    continue;
  }
}
```

## 3. pi-mono：最优雅的函数式设计

### 3.1 两层架构：函数式核心 + 状态壳

```
agent-loop.ts（函数式核心）     agent.ts（状态壳）
  │ → 纯函数，无可变状态          │ → Agent 类，管理 state + events
  │ → agentLoop() / Continue()    │ → prompt() / steer() / followUp()
  │ → 返回 EventStream            │ → 订阅 events，更新 UI
  ▼                                ▼
EventStream<AgentEvent, AgentMessage[]>
  │ → push(event) / end(result)
  │ → for await (event of stream)
  ▼
streamSimple()（LLM 调用）
```

### 3.2 核心 Loop — 双层嵌套

```
外层循环（follow-up messages）：
  检查 agent 停止后是否有 follow-up 消息

  内层循环（tool calls + steering）：
    1. 注入 pending messages（steering 或 follow-up）
    2. 流式获取 assistant response
    3. 如果 error/aborted：emit 事件，return
    4. 如果有 tool calls：顺序执行
    5. 每个 tool 执行后：检查 steering messages
    6. 如果有 steering：跳过剩余 tool calls，回到 step 1
    7. 如果没有更多 tool calls 且没有 steering：退出内层循环

  检查 follow-up messages
  如果有 → 设为 pending，重启内层循环
  如果没有 → 退出外层循环，emit agent_end
```

### 3.3 Steering 机制（中途改变方向）

```
Agent 正在执行 Tool A → Tool B → Tool C
                          ↑
                   用户发送 steering 消息
                          ↓
              Tool C 被跳过（标记为 error: "Skipped"）
              steering 消息注入下一轮 LLM 调用
```

- **steering 队列**：中断正在运行的工具链，立即将用户新指令注入
- **follow-up 队列**：在 agent 本来要停止时追加新任务
- 两种队列支持 `one-at-a-time` 或 `all` 两种消费模式

### 3.4 EventStream 架构

```typescript
// 10 种事件类型覆盖完整生命周期
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
```

**关键设计**：用 `EventStream<T, R>` 将事件生产和消费完全解耦，producer 用 `push()`，consumer 用 `for await`。

### 3.5 消息抽象边界

```typescript
// AgentMessage 是扩展类型，可以携带自定义消息
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// convertToLlm 在最后时刻将 AgentMessage[] 转为 LLM 可理解的 Message[]
config.convertToLlm(agentMessages) → Message[]
```

应用可以在对话中携带任意自定义消息类型（UI 通知、artifact 等），转换到 LLM 格式的工作延迟到调用前一刻。

### 3.6 终止判断

```typescript
// 内层循环退出条件
if (response.stopReason !== 'tool_call' && !hasSteering) {
  break; // 模型没有请求工具且没有 steering → 完成
}
```

同样不需要额外 LLM 调用。

## 4. Codex：工程最完善的 Rust 实现

### 4.1 Actor 模型架构

```
Codex::spawn()
  │
  ├─ tx_sub / rx_sub   (Op 提交通道，bounded=64)
  ├─ tx_event / rx_event (Event 输出通道，unbounded)
  └─ Session（可变状态）

submission_loop:
  while let Ok(sub) = rx_sub.recv().await {
    match sub.op {
      Op::UserInput    → handlers::user_input_or_turn
      Op::ExecApproval → handlers::exec_approval
      Op::Compact      → handlers::compact
      Op::Interrupt    → handlers::interrupt
      Op::Shutdown     → break
      ...
    }
  }
```

**关键设计**：调用者通过 channel 发送 `Op`，接收 `Event`。Session 运行在独立 Tokio 任务中，单线程顺序处理，天然避免并发问题。

### 4.2 Turn 生命周期

```
user_input_or_turn
  │
  ├─ 先尝试 steer（注入到正在运行的 turn）
  │
  └─ 否则 spawn_task(RegularTask)
       │ → abort 所有现有 tasks
       │ → 创建 CancellationToken
       │ → Tokio spawn RegularTask::run()
       ▼
     run_turn()（外层 turn 循环）
       │
       loop {
         │ pending_input = sess.get_pending_input()
         │ history = sess.clone_history().for_prompt()
         │
         ├─ run_sampling_request()
         │    │
         │    └─ try_run_sampling_request()（内层 streaming 循环）
         │         │ → stream = client.stream(prompt)
         │         │ → 处理事件：Text, ToolCall, Reasoning, Error
         │         │ → tool call futures → FuturesOrdered
         │         │ → stream 结束后 drain all tool futures
         │         └─ 返回 { needs_follow_up, last_agent_message }
         │
         ├─ token_limit_reached → auto-compact → continue
         ├─ needs_follow_up=true → continue（工具结果需要回传给模型）
         └─ needs_follow_up=false → break（完成）
       }
```

### 4.3 并行工具执行

```rust
// ToolCallRuntime
// 支持并行的 tool → 获取 read lock（允许并发）
// 不支持并行的 tool → 获取 write lock（独占执行）
```

- 工具执行在 streaming 过程中就开始（`OutputItemDone` 时 push future）
- 所有 futures 收集到 `FuturesOrdered`，stream 结束后统一 `drain`
- 每个工具有独立的 `CancellationToken`

### 4.4 重试 + Transport Fallback

```rust
loop {
  match try_run_sampling_request().await {
    Ok(output)                    → return Ok(output),
    Err(ContextWindowExceeded)    → return Err(..),
    Err(non_retryable)            → return Err(..),
    Err(retryable) if retries < max → {
      sleep(backoff(retries));  // 指数退避
      retries += 1;
      continue;
    }
    Err(_) if can_switch_transport → {
      // WebSocket 失败 → 降级到 HTTPS SSE
      client.switch_fallback_transport();
      retries = 0;
      continue;
    }
  }
}
```

### 4.5 Tool 审批机制

```
Tool 执行请求
  │
  ▼
ToolOrchestrator（三阶段 pipeline）
  │
  ├─ 1. Approval: 检查策略，可能弹出 UI 审批
  │     └─ 使用 oneshot channel：tool 挂起等待 → UI 接收请求 → 用户决定 → resolve
  │
  ├─ 2. Sandbox: 选择沙箱模式（None / Seatbelt / Landlock）
  │
  └─ 3. Execute: 执行工具，沙箱拒绝时可升级重试
```

### 4.6 上下文管理

```rust
struct ContextManager {
  items: Vec<ResponseItem>,          // 有序消息历史
  token_info: Option<TokenUsageInfo>,
}

// 关键能力
record_items()      → 追加 + 自动 truncation
for_prompt()        → 归一化（确保 call/result 配对）
estimate_tokens()   → 字节级 heuristic 估算
auto_compact()      → token 超限时自动 compact
```

### 4.7 多 Agent 架构

```rust
AgentControl {
  spawn_agent()       → 创建子 session thread
  send_prompt()       → 给子 agent 发消息
  interrupt_agent()   → 中断子 agent
  shutdown_agent()    → 关闭子 agent
}

// 限制
MAX_THREAD_SPAWN_DEPTH = 1  // 最多嵌套一层
max_threads per session     // 原子计数器限制
SpawnReservation (RAII)     // 保证 slot 释放
```

## 5. 核心 Pattern 提炼

### Pattern 1：基于 finishReason 的终止判断

**三个项目都不需要额外 LLM 调用来判断是否结束。**

```
模型返回 finishReason:
  - "stop" / "end_turn" → 任务完成，退出循环
  - "tool_calls" → 执行工具后继续循环
  - "length" → 上下文超限，触发 compaction
```

### Pattern 2：三态返回信号

OpenCode 最明确：processor 返回 `"continue"` / `"stop"` / `"compact"`，将处理逻辑和控制流解耦。

### Pattern 3：流式处理是标配

三个项目全部使用 streaming：
- OpenCode: `streamText()` → event-by-event 处理
- pi-mono: `EventStream` async iterable
- Codex: SSE / WebSocket streaming

### Pattern 4：上下文管理必不可少

| 项目 | Compaction | Truncation | Token 计数 |
|------|-----------|------------|-----------|
| OpenCode | 自动 compaction agent | prune 旧 tool outputs | 模型返回 usage |
| pi-mono | `transformContext` 回调 | 应用层自行实现 | 依赖 provider |
| Codex | auto-compaction | TruncationPolicy | 字节 heuristic |

### Pattern 5：Steering / 中断能力

| 项目 | 中断方式 | Steering |
|------|---------|----------|
| OpenCode | AbortController + session cancel | 有（ephemeral message wrapping） |
| pi-mono | AbortSignal + steering queue | 有（最完整，支持 steer + follow-up） |
| Codex | CancellationToken + Op::Interrupt | 有（steer_input 注入） |

### Pattern 6：安全防护

- **Doom Loop 检测**：OpenCode 检查最近 3 次 tool call 是否完全相同
- **Step 限制**：OpenCode 的 `agent.steps` 限制最大迭代数
- **工具审批**：Codex 有完整的 permission → sandbox → execute pipeline
- **工具输出截断**：三个项目都对 tool output 做长度限制

## 6. 对比你的实现

| 能力 | 你的实现 | 业界做法 |
|------|---------|---------|
| **终止判断** | 额外 LLM 调用 (2x cost) | `finishReason` 信号 (0 cost) |
| **流式输出** | 无（`generateText`） | 全部使用 `streamText` / SSE |
| **上下文管理** | 无限增长 | compaction + truncation |
| **错误重试** | 简单计数 | 指数退避 + 错误分类 |
| **中断机制** | 无 | AbortController / CancellationToken |
| **死循环防护** | `MAX_TURNS=50` | doom loop 检测 + step 限制 |
| **工具执行** | SDK 单轮执行 | 流式 + 循环执行 |

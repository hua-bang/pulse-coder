# 文档一：当前代码实现分析

## 1. 项目概览

| 维度 | 详情 |
|------|------|
| **技术栈** | TypeScript + Vercel AI SDK (`ai` v6) |
| **LLM 提供商** | OpenAI 兼容 API（默认 DeepSeek v3 via Novita） |
| **项目结构** | pnpm monorepo，核心在 `apps/coder-demo/src/` |
| **入口** | `core.ts` → readline loop → `loop.ts` |

## 2. 核心文件结构

```
apps/coder-demo/src/
├── core.ts          # 入口：readline 交互，管理 Context
├── loop.ts          # Agent Loop 主循环
├── ai.ts            # LLM 调用封装（generateText / generateObject）
├── config/index.ts  # 配置：模型、MAX_TURNS、MAX_ERROR_COUNT
├── prompt/system.ts # System Prompt 生成
├── tools/           # 内置工具（read, write, bash, ls, tavily, skill）
├── skill/           # Skill 系统（scanner + registry）
└── typings/index.ts # 类型定义（Tool, Context）
```

## 3. Agent Loop 执行流程

```
用户输入
  │
  ▼
core.ts: context.messages.push({ role: 'user', content })
  │
  ▼
loop.ts: while (true) 进入主循环
  │
  ▼
ai.ts: generateTextAI(messages)
  ├─ 构造 system prompt + messages
  ├─ 调用 generateText({ model, messages, tools })
  └─ 返回 { text?, toolCalls?, toolResults? }
  │
  ├── Case A: 有 text 无 toolCalls
  │     ├─ push assistant message
  │     ├─ 调用 checkLoopFinish() 判断是否结束
  │     │    ├─ 额外发一次 LLM 请求
  │     │    └─ 用 generateObject 获取 { finish: boolean }
  │     ├─ finish=true → return text（结束）
  │     └─ finish=false → continue（继续循环）
  │
  ├── Case B: 有 toolCalls
  │     └─ push assistant message（含 tool-call 内容）
  │
  └── Case C: 有 toolResults
        └─ push tool message（含 tool-result 内容）
        └─ continue（回到循环让 LLM 看到结果）
```

## 4. LLM 调用方式

### 4.1 主调用 — `generateTextAI()`

```typescript
// ai.ts:12
const generateTextAI = (messages) => {
  return generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: [{ role: 'system', content: generateSystemPrompt() }, ...messages],
    tools: BuiltinToolsMap
  });
}
```

- **非流式**：使用 `generateText` 而不是 `streamText`，等到完整响应后才返回
- **工具执行由 SDK 完成**：Vercel AI SDK 的 `generateText` 在内部自动执行 tool，但只执行一轮（`maxSteps` 默认为 1）

### 4.2 结构化输出 — `generateObject()`

```typescript
// ai.ts:28
// 通过 toolChoice: { type: 'tool', toolName: 'respond' } 强制模型调用特定 tool
// 从而获取结构化 JSON 输出
```

## 5. Tool 系统

| Tool | 功能 | 实现方式 |
|------|------|----------|
| `read` | 读文件 | `fs.readFileSync` |
| `write` | 写文件 | `fs.writeFileSync`（含 `mkdirSync`） |
| `bash` | 执行命令 | `execSync`，maxBuffer 10MB |
| `ls` | 列目录 | `fs.readdirSync` |
| `tavily` | 网络搜索 | Tavily API |
| `skill` | 获取技能 | 从 SkillRegistry 查询 |

Tool 定义格式：

```typescript
interface Tool<Input, Output> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;     // Zod schema
  execute: (input: Input) => Promise<Output>;
}
```

## 6. 消息管理

```typescript
interface Context {
  messages: ModelMessage[];  // 简单数组，只增不减
}
```

- 消息存储在内存数组中，**无上限控制**
- 无 token 计数、无截断、无 compaction 机制
- 会话之间不共享上下文

## 7. 关键问题分析

### 问题 1：finish 判断用额外 LLM 调用，成本翻倍

```typescript
// loop.ts:11-36
async function checkLoopFinish(result, context) {
  // 每次无 tool call 的 text 响应都会触发一次额外的 LLM 调用
  const res = await generateObject(messages, z.object({
    finish: z.boolean()
  }), '...');
  return res.finish;
}
```

**问题**：每次 agent 产出纯文本回复时，都需要额外一次 LLM 请求来判断是否该结束。这意味着简单任务的 API 调用量直接翻倍。

### 问题 2：只有单轮工具执行

```typescript
// ai.ts — generateText 没有设置 maxSteps
// Vercel AI SDK 默认 maxSteps=1，意味着一次只能调用一轮工具
```

**问题**：SDK 只执行一轮 tool call。虽然外层 `while(true)` 循环可以多轮，但每轮是一次完整的 `generateText` 调用（含完整上下文），效率很低。

### 问题 3：无上下文管理

- 消息无限增长，最终会超出模型 context window
- 没有 token 计数
- 没有消息截断或 compaction 策略
- 工具输出没有长度限制

### 问题 4：非流式输出

- 使用 `generateText` 而非 `streamText`，用户看不到实时进度
- 长任务期间 UI 完全没有反馈（只有 "Processing..."）

### 问题 5：错误处理粗糙

```typescript
// loop.ts:95-106
catch (error) {
  messages.push({ role: 'assistant', content: `I encountered an error...` });
  error_count++;
  // 无重试、无退避、无错误分类
}
```

- 所有错误统一处理，不区分 rate limit / network error / validation error
- 没有 exponential backoff
- 错误消息被加入上下文，污染后续对话

### 问题 6：缺少 abort / 中断机制

- 没有 `AbortController`，用户无法中断正在执行的请求
- 没有 steering（中途改变指令）能力
- 没有工具执行超时

## 8. 总结

当前实现是一个**最小可运行的 agent loop**，核心逻辑约 110 行代码，已经具备：
- 基本的多轮工具调用循环
- Zod schema 驱动的工具系统
- Skill 系统框架

但缺少 production-grade agent 的关键能力：
- **上下文管理**（最紧急）
- **流式输出**（用户体验核心）
- **合理的终止判断**（成本关键）
- **错误恢复 / 重试**（稳定性基础）
- **中断控制**（可用性保障）

# 文档三：Agent Loop MVP 改造方案

## 设计原则

1. **保持简单**：在现有 Vercel AI SDK 基础上改造，不引入新框架
2. **最小改动**：优先改最影响效果的部分，不做过度工程
3. **向业界看齐**：借鉴 OpenCode 的架构（同为 TypeScript + Vercel AI SDK），但取其精华去其复杂

## 改造优先级

| 优先级 | 改造项 | 原因 | 预计工作量 |
|--------|--------|------|-----------|
| P0 | 用 `streamText` 替代 `generateText` | 流式输出是用户体验基础 | 中 |
| P0 | 用 `finishReason` 替代 `checkLoopFinish` | 消除 2x API cost | 小 |
| P0 | 使用 `maxSteps` 让 SDK 自动多轮 | 简化 loop 逻辑 | 小 |
| P1 | 工具输出截断 | 防止 context 爆炸 | 小 |
| P1 | 错误分类 + 指数退避 | 稳定性保障 | 小 |
| P1 | AbortController 中断支持 | 可用性保障 | 小 |
| P2 | 基础 compaction 机制 | 长对话支持 | 中 |
| P2 | Doom loop 检测 | 安全防护 | 小 |

---

## 改造一：流式输出 + finishReason 终止 + maxSteps 自动多轮

> 这是最核心的改造，将 `ai.ts` 和 `loop.ts` 重写

### 1.1 新的 `ai.ts`

```typescript
import { streamText, type ModelMessage, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL } from './config';
import { BuiltinTools } from './tools';
import { generateSystemPrompt } from './prompt';

const BuiltinToolsMap = BuiltinTools.reduce((acc, toolInstance) => {
  acc[toolInstance.name] = tool(toolInstance as Tool);
  return acc;
}, {} as Record<string, Tool>);

export interface StreamOptions {
  abortSignal?: AbortSignal;
  maxSteps?: number;
  onStepFinish?: (event: any) => void;
  onChunk?: (chunk: any) => void;
}

export const streamTextAI = (
  messages: ModelMessage[],
  options?: StreamOptions
) => {
  const finalMessages = [
    { role: 'system' as const, content: generateSystemPrompt() },
    ...messages,
  ];

  return streamText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools: BuiltinToolsMap,
    maxSteps: options?.maxSteps ?? 25,        // 允许多轮工具调用
    abortSignal: options?.abortSignal,
    onStepFinish: options?.onStepFinish,
    onChunk: options?.onChunk,
  });
};
```

**关键改动**：
- `generateText` → `streamText`：流式输出
- `maxSteps: 25`：Vercel AI SDK 自动处理多轮工具调用循环，不再需要外层手动管理
- `abortSignal`：支持取消

### 1.2 新的 `loop.ts`

```typescript
import type { ModelMessage, StepResult } from 'ai';
import { streamTextAI, type StreamOptions } from './ai';
import { MAX_ERROR_COUNT } from './config';
import type { Context } from './typings';

export interface LoopOptions {
  onText?: (delta: string) => void;           // 流式文本回调
  onToolCall?: (toolCall: any) => void;       // 工具调用通知
  onToolResult?: (toolResult: any) => void;   // 工具结果通知
  onStepFinish?: (step: StepResult<any>) => void;  // 步骤完成通知
  abortSignal?: AbortSignal;                  // 取消信号
}

async function loop(context: Context, options?: LoopOptions): Promise<string> {
  const { messages } = context;
  let errorCount = 0;

  while (true) {
    try {
      const result = streamTextAI(messages, {
        abortSignal: options?.abortSignal,
        onStepFinish: (event) => {
          options?.onStepFinish?.(event);
        },
        onChunk: (chunk) => {
          // 流式输出文本片段
          if (chunk.type === 'text-delta') {
            options?.onText?.(chunk.textDelta);
          }
        },
      });

      // 消费流，等待完成
      const finalResult = await result;
      const text = await finalResult.text;
      const steps = await finalResult.steps;

      // 将 SDK 产生的所有中间消息合并到 context
      // steps 包含了所有轮次的 messages
      for (const step of steps) {
        // assistant message (可能包含 tool calls)
        if (step.text || step.toolCalls?.length) {
          messages.push({
            role: 'assistant',
            content: step.toolCalls?.length
              ? step.toolCalls.map(tc => ({
                  type: 'tool-call' as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  input: tc.args,
                }))
              : step.text,
          });
        }
        // tool results
        if (step.toolResults?.length) {
          messages.push({
            role: 'tool',
            content: step.toolResults.map(tr => ({
              type: 'tool-result' as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              output: { type: 'json', value: tr.result },
            })),
          });
        }
      }

      // === 终止判断：基于 finishReason ===
      const finishReason = await finalResult.finishReason;

      if (finishReason === 'stop' || finishReason === 'end_turn') {
        // 模型主动停止 → 任务完成
        return text || 'Task completed.';
      }

      if (finishReason === 'length') {
        // 达到 token 上限 → 需要 compaction（P2 实现）
        // MVP 阶段先直接返回已有文本
        return text || 'Context limit reached.';
      }

      // finishReason === 'tool-calls' 但 maxSteps 耗尽
      // 说明 agent 在 25 步内没完成，返回当前结果
      return text || 'Max steps reached, task may be incomplete.';

    } catch (error: any) {
      // === 错误分类 + 指数退避（见改造三）===
      errorCount++;
      if (errorCount >= MAX_ERROR_COUNT) {
        return `Failed after ${errorCount} errors: ${error.message}`;
      }

      // 对于 rate limit 错误等可重试错误，等待后重试
      if (isRetryableError(error)) {
        const delay = Math.min(2000 * Math.pow(2, errorCount - 1), 30000);
        await sleep(delay);
        continue;
      }

      // 不可重试的错误直接返回
      return `Error: ${error.message}`;
    }
  }
}

function isRetryableError(error: any): boolean {
  const status = error?.status || error?.statusCode;
  // 429 = rate limit, 500/502/503 = server error
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default loop;
```

**关键改动**：
1. **删除 `checkLoopFinish()`**：不再需要额外 LLM 调用，靠 `finishReason` 判断
2. **`maxSteps: 25`**：SDK 自动管理多轮工具调用，外层 loop 只需一次调用
3. **流式回调**：`onText` 回调实现实时输出
4. **简化逻辑**：从 110 行减少到约 80 行，同时功能更强

### 1.3 新的 `core.ts` 改动

```typescript
// 核心改动：增加 AbortController + 流式输出
const ac = new AbortController();

// 用户按 Ctrl+C 时中断当前请求
process.on('SIGINT', () => {
  ac.abort();
  // 重新创建 controller 供下次使用
});

const result = await loop(context, {
  abortSignal: ac.signal,
  onText: (delta) => {
    process.stdout.write(delta);  // 实时输出文本片段
  },
  onToolCall: (tc) => {
    console.log(`\n[Tool] ${tc.toolName}(${JSON.stringify(tc.args)})`);
  },
  onStepFinish: (step) => {
    console.log(`\n[Step finished] reason: ${step.finishReason}`);
  },
});
```

---

## 改造二：工具输出截断

> 防止单个工具返回巨大输出导致 context 爆炸

### 在 tool 定义中统一截断

```typescript
// tools/index.ts 或新建 tools/utils.ts
const MAX_TOOL_OUTPUT_LENGTH = 30_000; // ~8K tokens

export function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  const half = Math.floor(MAX_TOOL_OUTPUT_LENGTH / 2);
  return (
    output.slice(0, half) +
    `\n\n... [truncated ${output.length - MAX_TOOL_OUTPUT_LENGTH} characters] ...\n\n` +
    output.slice(-half)
  );
}
```

在每个 tool 的 execute 中 wrap：

```typescript
// 以 bash tool 为例
execute: async (input) => {
  const output = execSync(input.command, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return { output: truncateOutput(output) };
}
```

---

## 改造三：错误分类 + 指数退避

> 已包含在改造一的 `loop.ts` 中，核心逻辑如下

```typescript
function isRetryableError(error: any): boolean {
  const status = error?.status || error?.statusCode;
  return status === 429 || status === 500 || status === 502 || status === 503;
}

// 指数退避：2s → 4s → 8s → 16s，上限 30s
const delay = Math.min(2000 * Math.pow(2, errorCount - 1), 30000);
```

与当前实现的区别：
- **不污染上下文**：错误不再作为 assistant message 添加到 messages 中
- **分类处理**：rate limit 和 server error 会重试，其他错误直接返回
- **指数退避**：避免频繁请求加重 rate limit

---

## 改造四：基础 Doom Loop 检测

> 参考 OpenCode，防止 agent 无限循环调用相同工具

```typescript
// 在 loop.ts 的 onStepFinish 中检测
const recentToolCalls: Array<{ name: string; args: string }> = [];
const DOOM_LOOP_THRESHOLD = 3;

onStepFinish: (step) => {
  if (step.toolCalls?.length) {
    for (const tc of step.toolCalls) {
      recentToolCalls.push({
        name: tc.toolName,
        args: JSON.stringify(tc.args),
      });
    }

    // 只保留最近的调用
    while (recentToolCalls.length > DOOM_LOOP_THRESHOLD) {
      recentToolCalls.shift();
    }

    // 检查最近 N 次是否完全相同
    if (recentToolCalls.length === DOOM_LOOP_THRESHOLD) {
      const first = recentToolCalls[0];
      const allSame = recentToolCalls.every(
        tc => tc.name === first.name && tc.args === first.args
      );
      if (allSame) {
        console.warn('[Warning] Doom loop detected, aborting...');
        ac.abort(); // 中断循环
      }
    }
  }
}
```

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/ai.ts` | **重写** | `generateText` → `streamText` + `maxSteps` |
| `src/loop.ts` | **重写** | 删除 `checkLoopFinish`，基于 `finishReason` 终止 |
| `src/core.ts` | **修改** | 增加 AbortController + 流式输出回调 |
| `src/tools/utils.ts` | **新增** | `truncateOutput` 工具 |
| `src/tools/bash.ts` | **修改** | 使用 `truncateOutput` |
| `src/tools/read.ts` | **修改** | 使用 `truncateOutput` |
| `src/config/index.ts` | **修改** | 增加 `MAX_STEPS`、`MAX_TOOL_OUTPUT_LENGTH` 常量 |

## 预期效果

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| **API 调用数** | 每次纯文本回复 2 次 | 1 次 |
| **用户等待体验** | 完全阻塞 | 流式实时输出 |
| **多轮工具调用** | 外层循环手动管理 | SDK 自动 `maxSteps` |
| **长对话风险** | context 无限增长 → API 报错 | 工具输出截断 + 未来 compaction |
| **错误恢复** | 计数退出 | 分类重试 + 指数退避 |
| **中断能力** | 无 | Ctrl+C 中断当前请求 |
| **死循环防护** | 仅 MAX_TURNS | doom loop 检测 + step 限制 |

## 未来迭代方向（P2+，不在 MVP 范围内）

1. **Compaction 机制**：当 token 接近上限时，用独立的 LLM 调用总结历史，参考 OpenCode 的 `compaction agent`
2. **Sub-agent 架构**：参考 pi-mono 的 `task` tool，支持委派子任务给专用 agent
3. **Permission 系统**：参考 Codex 的 `ToolOrchestrator`，对危险操作（bash rm、git push 等）做审批
4. **会话持久化**：参考 Codex 的 rollout 机制，将会话保存到文件系统，支持恢复
5. **事件总线**：参考 OpenCode 的 `Bus`，实现 UI 和 agent loop 的完全解耦

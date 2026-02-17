# 05｜上下文管理与压缩策略（Compaction）

## 1. 为什么需要 Compaction

在多轮 Agent 会话中，`context.messages` 会持续增长。当前实现通过 `context/index.ts` 提供主动压缩机制，避免：
- 超出模型上下文窗口
- 输入成本持续增长
- 历史噪声影响后续推理质量

## 2. 触发与目标阈值

来自 `config/index.ts`：
- `CONTEXT_WINDOW_TOKENS`（默认 64000）
- `COMPACT_TRIGGER`（默认窗口 75%）
- `COMPACT_TARGET`（默认窗口 50%）
- `KEEP_LAST_TURNS`（默认保留最近 6 个 user turn）
- `MAX_COMPACTION_ATTEMPTS`（默认 2）

## 3. Token 估算方法

当前实现使用轻量估算：
- 字符总数 / 4 ≈ token 数

这是工程化折中：
- 优点：快、无需模型 tokenizer
- 缺点：精度有限，尤其在中英文混合或结构化 message 时有偏差

## 4. 压缩流程

```mermaid
flowchart TD
    A[maybeCompactContext] --> B{messages empty?}
    B -- yes --> Z[didCompact=false]
    B -- no --> C[estimateTokens]
    C --> D{force or >= trigger?}
    D -- no --> Z
    D -- yes --> E[splitByTurns: old + recent]
    E --> F{old empty?}
    F -- yes --> Z
    F -- no --> G[summarize old messages]
    G --> H[ensure prefix [COMPACTED_CONTEXT]]
    H --> I[new = summary assistant + recent]
    I --> J{new > target?}
    J -- yes --> K[fallback takeLastTurns]
    J -- no --> L[return compacted new messages]

    G -- error --> M[pruneMessages fallback]
    M --> K
```

## 5. 核心步骤解释

### 5.1 按 turn 切分

`splitByTurns` 以用户消息索引切分：
- 老历史：用于摘要
- 最近 N 个 turn：原样保留

这保证最近上下文语义不丢失。

### 5.2 摘要写回

成功摘要后，会构造新 messages：
1. `assistant` 角色写入 `[COMPACTED_CONTEXT]...`
2. 追加最近原始消息

### 5.3 双 fallback

当摘要失败或摘要太大时：
- 使用 `pruneMessages` 先清理 reasoning/tool calls 空消息等
- 再 `takeLastTurns` 保留最近窗口

## 6. loop 中的调用策略

loop 里有两种调用时机：
1. 常规入口：每轮开始时尝试（若未达到阈值会快速跳过）
2. 强制压缩：`finishReason='length'` 时 `force=true` 再尝试一次

并受 `MAX_COMPACTION_ATTEMPTS` 限制，避免反复压缩循环。

## 7. 设计优点

- 将“语义压缩”与“机械裁剪”组合，兼顾质量和鲁棒性。
- 保留最近 turn，降低任务上下文突变。
- 压缩结果通过 `onCompacted` 回调可观测。

## 8. 已知约束

- `Context` 本身未在 `maybeCompactContext` 内原地更新；需要调用方在回调中写回（当前 loop 逻辑也依赖外围消息管理策略）。
- token 估算粗粒度，可能出现“误判触发”或“触发偏晚”。
- 摘要消息固定为 `assistant` 角色，长期看可考虑单独 metadata 标记避免歧义。

## 9. 建议演进

1. 明确 `context.messages` 更新语义（在 loop 中直接提交，或通过回调契约强制提交）。
2. 增加 tokenizer 可选实现（按 provider 选择精确计数）。
3. 记录 compaction 前后 token 对比与压缩率。
4. 支持多级摘要（summary-of-summary）以适配超长会话。

---

本章结论：当前 compaction 已有“可用策略闭环”，下一步关键是强化“数据一致性语义 + 指标可观测 + 精确计数”。
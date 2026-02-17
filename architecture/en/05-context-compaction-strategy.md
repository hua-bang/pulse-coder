# 05 | Context Management and Compaction Strategy

## 1. Why Compaction is Needed

In multi-turn agent sessions, `context.messages` keeps growing. The current implementation uses `context/index.ts` for proactive compaction to avoid:
- Exceeding model context window
- Continuously increasing input cost
- Historical noise degrading reasoning quality

## 2. Trigger and Target Thresholds

From `config/index.ts`:
- `CONTEXT_WINDOW_TOKENS` (default 64000)
- `COMPACT_TRIGGER` (default 75% of window)
- `COMPACT_TARGET` (default 50% of window)
- `KEEP_LAST_TURNS` (default keep recent 6 user turns)
- `MAX_COMPACTION_ATTEMPTS` (default 2)

## 3. Token Estimation Method

Current implementation uses lightweight estimation:
- total chars / 4 ≈ token count

Engineering trade-off:
- Pros: fast, no tokenizer dependency
- Cons: limited accuracy, especially for mixed-language or structured messages

## 4. Compaction Flow

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

## 5. Key Steps Explained

### 5.1 Split by turn

`splitByTurns` uses user message indexes to split:
- old history: for summarization
- recent N turns: preserved as-is

This protects near-term semantic continuity.

### 5.2 Write summary back

After successful summary, new messages are built as:
1. `assistant` message with `[COMPACTED_CONTEXT]...`
2. append recent original messages

### 5.3 Double fallback

If summary fails or summary is still too large:
- use `pruneMessages` to clean empty reasoning/tool-call artifacts
- then `takeLastTurns` as hard fallback

## 6. Invocation Strategy in Loop

The loop calls compaction in two moments:
1. Normal entry: attempt each round (fast skip if below threshold)
2. Forced compaction: on `finishReason='length'`, retry with `force=true`

Both are bounded by `MAX_COMPACTION_ATTEMPTS` to avoid compaction loops.

## 7. Design Strengths

- Combines semantic summarization with mechanical pruning for quality + robustness.
- Preserves recent turns to reduce sudden context drift.
- Exposes `onCompacted` callback for observability.

## 8. Known Constraints

- `Context` is not updated in-place inside `maybeCompactContext`; caller must commit updates via callback/flow.
- Token estimation is coarse and may trigger too early/late.
- Summary message uses fixed `assistant` role; metadata-based marker may be cleaner long-term.

## 9. Suggested Evolution

1. Clarify message update semantics (`loop` direct commit vs callback contract).
2. Add optional tokenizer-based accurate counting per provider.
3. Record before/after tokens and compaction ratio.
4. Support multi-level summary (summary-of-summary) for extra long sessions.

---

Conclusion: Current compaction already forms a usable strategy loop. Next key work is data consistency semantics, observability metrics, and accurate token counting.

---
name: session-digest
description: Summarize sessions across a multi-day range by paging session_summary in chunks, output bilingual, and write back stable soul traits.
description_zh: 通过分段调用 session_summary 汇总多天会话，输出中英双语摘要，并在稳定特征出现时写回 soul。
version: 1.0.0
author: Pulse Coder Team
---

# Session Digest Skill

Summarize sessions over a long date range without blowing context by paging `session_summary` in windows and aggregating the results.

## When to Use

- You need summaries for many days (e.g., 14/30/90 days)
- Single tool output is too large to fit in context
- You want a high-level digest with minimal raw excerpts

## Inputs (JSON)

```json
{
  "days": 30,
  "chunkDays": 7,
  "scope": "owner",
  "includeUserMessages": true,
  "includeAssistantMessages": true,
  "maxMessagesPerSession": 120,
  "focus": "optional: emphasize PRs, configs, incidents, or product decisions",
  "format": "themes"
}
```

- `days` (default 7): total days to summarize (UTC, counting back from today).
- `chunkDays` (default 7, max 30): size of each window.
- `scope`: `owner` (cross-channel) or `platform` (current channel).
- `maxMessagesPerSession`: reduce to avoid overlong excerpts.
- `format`: `themes` or `timeline`.

## Required Execution Flow

1. Compute `totalDays` from input (default 7).
2. Compute `chunkDays` (default 7, clamp 1..30).
3. For each window index `i = 0..`:
   - `offsetDays = i * chunkDays`
   - `windowDays = min(chunkDays, totalDays - offsetDays)`
   - Call `session_summary` with:
     ```json
     {
       "days": windowDays,
       "offsetDays": offsetDays,
       "scope": "owner",
       "includeUserMessages": true,
       "includeAssistantMessages": true,
       "maxMessagesPerSession": 120
     }
     ```
   - Summarize this window to **3-6 bullets**, no raw excerpt dumps.
4. Aggregate across windows:
   - Deduplicate repeated items.
   - Highlight: PRs/MRs, code changes, config changes, incidents, decisions.
5. Produce bilingual output (EN + ZH) with the format below.
6. **Soul writeback (no read):**
   - Do NOT call `memory_recall`.
   - Infer 1-2 stable traits only when the same tendency appears in **>= 2 sessions or windows**.
   - Record with `memory_record` using `kind: "soul"` and a short, neutral sentence (no sensitive or user-facing text).
   - Do not mention the soul writeback in the visible output.

## Output Format

- Start with the date range (UTC).
- Provide English then Chinese sections.
- Keep each language concise (target <= 1200 chars; avoid long excerpts).

Example:

```
Date Range (UTC): 2025-03-01 to 2025-03-07

EN
Overall:
- ...
- ...
Per-window:
- 2025-03-07: ...
- 2025-03-06: ...
Notable:
- ...

ZH
总体:
- ...
- ...
分段:
- 2025-03-07: ...
- 2025-03-06: ...
要点:
- ...
```

## Output Rules

- Never paste the raw `session_summary.sessions[].excerpt` list.
- Prefer concise phrasing and avoid low-signal chat.
- If a window has no sessions, say so explicitly.
- Keep total output under ~300 lines.

## Example Invocation

```text
/skills session-digest {"days": 30, "chunkDays": 7, "scope": "owner"}
```

---
name: session-digest
description: Summarize sessions across a multi-day range by paging session_summary in chunks.
description_zh: 通过分段调用 session_summary 汇总多天会话，避免一次拉取过多内容。
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
5. Output format:
   - **Overall** (5-8 bullets)
   - **Per-window digest** (date range + 3-6 bullets)
   - **Notable items** (optional; PR links, branches, releases)

## Output Rules

- Never paste the raw `session_summary.sessions[].excerpt` list.
- Prefer concise phrasing and avoid low-signal chat.
- If a window has no sessions, say so explicitly.
- Keep total output under ~300 lines.

## Example Invocation

```text
/skills session-digest {"days": 30, "chunkDays": 7, "scope": "owner"}
```

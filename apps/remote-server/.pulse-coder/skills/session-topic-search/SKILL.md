---
name: session-topic-search
description: Find sessions by topic using multi-keyword matching and return session IDs
description_zh: 通过多关键词匹配查找相关会话并返回会话ID
version: 1.0.0
author: Pulse Coder Team
---

# Session Topic Search Skill

Locate sessions related to a user-specified topic and return matching session IDs. This skill uses multi-keyword matching to score relevance.

## When to Use

- User asks to find sessions about a topic and wants session IDs
- User needs to backtrack discussion history by keywords

## Input Parsing

- Extract keywords from the user message.
- Support multiple keywords separated by spaces, commas, Chinese commas, or semicolons.
- Treat quoted phrases as a single keyword.
- Defaults:
  - Search window: last 30 days
  - Result limit: 10
  - Scope: owner (all channels)

## Matching Rules (Multi-Keyword)

- Normalize all text to lowercase.
- Default mode: AND (all keywords must appear).
- Each keyword is matched as a substring in the session text.
- Score = total keyword hit count + recency bonus.
- Sort by score desc, then recency.

If AND yields no results, relax to OR and clearly label the fallback in the output.

## Workflow

1. Parse keywords, days, limit, and scope hints from the user message.
2. Call `session_summary` for the target window.
   - Use `includeUserMessages: true` and `includeAssistantMessages: true`.
   - Use `maxMessagesPerSession` up to 200 for better matching.
3. If no matches, expand the window in 30-day slices up to 90 days using `offsetDays` (0, 30, 60).
4. Score and rank sessions.
5. Return session IDs with a brief match note (keyword hits). Keep output concise.

## Output Format

- Provide a short list of session IDs, ordered by relevance.
- Each line includes: session id, matched keywords, and a 1-line note.
- If none, say no matches and ask for refined keywords or a longer time window.

## Example

User: "找关于缓存 失效 策略 的会话，最近 45 天"

Assistant flow:
- Keywords: ["缓存", "失效", "策略"]
- Days: 45 (split into 30 + 15 via offset)
- Search and rank
- Return session IDs

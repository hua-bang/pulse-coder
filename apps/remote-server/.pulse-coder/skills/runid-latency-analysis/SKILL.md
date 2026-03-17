---
name: runid-latency-analysis
description: Analyze runId latency and performance from devtools data. Use when asked to investigate a specific runId's timing, identify bottlenecks across LLM/Tool/Engine Plugin, or produce a fixed bilingual (ZH+EN) diagnosis report with metrics and hypotheses.
---

# RunId Latency Analysis

## Overview
Provide a fixed, structured diagnosis for a specific runId using devtools data and timing spans, with clear bottleneck classification and next actions. Output both Chinese and English reports (Chinese first).

## Workflow
1. Confirm inputs and scope
   - Required: runId
   - Optional: base URL/environment, sessionId, time window, focus area (LLM vs Tool vs Plugin)

2. Load run data
   - Prefer devtools API endpoints. If unknown, open `apps/remote-server/src/routes/devtools.ts` to confirm.
   - Fallback: search `~/.pulse-coder/remote-sessions` session JSON or devtools UI export.

3. Extract metrics
   - LLM spans: TTFB, TTFT, TTFT(text), Stream, Tool Wait, Tool Exec, usage, cached tokens
   - Tool spans: wait/exec durations, tool name, input/output size if present
   - Engine plugin spans: hook name and duration
   - Timeline: per-turn boundaries and idle gaps
   - Use `references/metrics.md` for definitions and fallback rules.

4. Diagnose bottleneck category
   - Classify as: LLM/network/model, Tool queue, Tool execution, Engine/plugin overhead, or Idle gap
   - Support with 2–3 strongest metrics and mention missing data if any.

5. Produce report (fixed bilingual template, Chinese then English)

## Fixed Report Template (ZH + EN)

```
RunId 延迟报告 (中文)

1) 摘要
- RunId: <runId>
- 总体结论: <一句话结论>
- 主要瓶颈: <LLM/Tool/Plugin/Idle>

2) 关键指标 (LLM)
- TTFB: <value or N/A>
- TTFT: <value or N/A>
- TTFT(text): <value or N/A>
- Stream: <value or N/A>
- Tool Wait (during LLM): <value or N/A>
- Tool Exec (during LLM): <value or N/A>
- Cached input tokens: <value or N/A>
- Total tokens: <value or N/A>

3) Tool 耗时 (Top 3)
- <toolName>#<index>: wait <x>, exec <y>, notes <...>
- <toolName>#<index>: wait <x>, exec <y>, notes <...>
- <toolName>#<index>: wait <x>, exec <y>, notes <...>

4) Engine Plugin 耗时 (Top 3)
- <pluginName>.<hook>: <duration>
- <pluginName>.<hook>: <duration>
- <pluginName>.<hook>: <duration>

5) Timeline 备注
- Turn 边界: <T1..Tn>
- Idle gaps: <位置/原因>

6) 诊断
- <简短推理 + 证据>

7) 下一步行动
- <action 1>
- <action 2>

RunId Latency Report (English)

1) Summary
- RunId: <runId>
- Overall impression: <one-line conclusion>
- Primary bottleneck: <LLM/Tool/Plugin/Idle>

2) Key Metrics (LLM)
- TTFB: <value or N/A>
- TTFT: <value or N/A>
- TTFT(text): <value or N/A>
- Stream: <value or N/A>
- Tool Wait (during LLM): <value or N/A>
- Tool Exec (during LLM): <value or N/A>
- Cached input tokens: <value or N/A>
- Total tokens: <value or N/A>

3) Tool Spans (Top 3)
- <toolName>#<index>: wait <x>, exec <y>, notes <...>
- <toolName>#<index>: wait <x>, exec <y>, notes <...>
- <toolName>#<index>: wait <x>, exec <y>, notes <...>

4) Engine Plugin Spans (Top 3)
- <pluginName>.<hook>: <duration>
- <pluginName>.<hook>: <duration>
- <pluginName>.<hook>: <duration>

5) Timeline Notes
- Turn boundaries: <T1..Tn>
- Idle gaps: <where/why>

6) Diagnosis
- <short reasoning with evidence>

7) Next Actions
- <action 1>
- <action 2>
```

## Handling Missing Data
- If timing fields are missing (older runs), set the metric to N/A and mention it explicitly.
- If firstTextAt is missing (tool-call-first), set TTFT(text) to N/A.
- If cached tokens are missing, use usage raw fallbacks (see references).
- Keep Chinese and English sections consistent, even when values are N/A.

## Resources
- `references/metrics.md`: definitions, field mapping, and heuristics

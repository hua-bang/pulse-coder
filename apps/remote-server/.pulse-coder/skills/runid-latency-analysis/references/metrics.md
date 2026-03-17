# RunId Latency Metrics Reference

Use this reference to interpret devtools run data and fill the fixed report template.

## Data Sources
- Devtools API: confirm endpoints in `apps/remote-server/src/routes/devtools.ts`.
- Session store fallback: `~/.pulse-coder/remote-sessions/sessions/*.json` (search runId).
- Devtools UI export (if API not available).

## LLM Timing Definitions
- **TTFB**: `firstChunkAt - requestStartAt`
- **TTFT**: `firstTextAt - requestStartAt` (text received)
- **TTFT(text)**: same as TTFT; set N/A if `firstTextAt` is missing
- **Stream**: `lastChunkAt - firstChunkAt`
- **Tool Wait**: time between tool requested and tool start (if provided)
- **Tool Exec**: `toolEndAt - toolStartAt`

Notes:
- If `firstTextAt` is missing and the first output is a tool call, TTFT(text) is N/A.
- If TTFB ~= TTFT, engine prep is likely near zero and the first chunk already contained text.

## Cached Token Fallback Order
Use these fields in order; take the first present value:
1. `cachedInputTokens`
2. `inputTokenDetails.cacheReadTokens`
3. `raw.input_tokens_details.cached_tokens`
4. `prompt_tokens_details.cached_tokens`

## Bottleneck Heuristics
- **High TTFB/TTFT**: likely network latency, model queueing, or provider-side delay.
- **High Tool Wait**: tool scheduling/queueing or external dependency contention.
- **High Tool Exec**: tool runtime or external API slowness.
- **High Plugin Span**: plugin hook overhead (identify plugin+hook).
- **Idle gaps** between spans: engine idle, external wait, or missing instrumentation.

## Quick Checklist
- Are the slowest spans LLM, Tool, Plugin, or idle gaps?
- Are there repeated spikes across turns or a single outlier?
- Is cached token usage high (suggesting prompt cache hit)?

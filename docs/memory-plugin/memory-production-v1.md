# Memory Production V1 (Write Policy)

Status: proposed
Owner: platform
Last updated: 2026-02-22

## 1. Goal

Define a production-safe memory write policy for the current local-first memory plugin.

This policy keeps the current architecture (`state.json` + `vectors.sqlite`) and focuses on write quality, not storage migration.

## 2. Scope

In scope:
- memory write decisions
- write gates (quality, dedupe, quotas)
- explicit vs automatic writes
- observability and rollout

Out of scope:
- replacing storage with a new backend
- changing read APIs (`memory_recall` to `memory_search/memory_get`)

## 3. Final Decisions

### 3.1 User-scope memory

- User-scope is explicit-first.
- Only explicit user intent should create durable long-term memory.
- Typical explicit signals: "remember this", "以后都这样", "必须长期遵守".

### 3.2 Daily log memory

- Daily log is semi-automatic, not full transcript.
- Only high-signal entries are written.
- Default scope for daily log is session-scope.

### 3.3 No full transcript persistence

- Do not copy all turns into memory.
- Store distilled facts/decisions/fixes/constraints only.

## 4. Write Entry Points

1) Explicit tool write
- Tool: `memory_record`
- Purpose: stable preference/rule/fix requested by user
- Can produce user-scope entries

2) Automatic daily log write
- Trigger: post-run (successful turn)
- Input: user text + assistant text (+ optional tool outcomes)
- Produces session-scope entries by default

## 5. Daily Log Write Funnel

Apply in order:

1. Candidate extraction
- Allowed types: `decision`, `fix`, `constraint`, `fact`
- Ignore small talk and acknowledgements

2. Quality gate
- `confidence >= MEMORY_DAILY_LOG_MIN_CONFIDENCE` (default 0.65)
- minimum content length and information density checks

3. Dedupe/merge
- Same day + same `dedupeKey` => update existing entry instead of inserting
- Merge fields: `lastSeenAt`, `hitCount`, optional confidence/importance max

4. Quotas
- Per turn max: `MEMORY_DAILY_LOG_MAX_PER_TURN` (default 3)
- Per day max: `MEMORY_DAILY_LOG_MAX_PER_DAY` (default 30)

5. Commit
- Batch commit once per successful turn
- Fail-open: write failure must not block user response path

## 6. Suggested Defaults

- `MEMORY_DAILY_LOG_ENABLED=true`
- `MEMORY_DAILY_LOG_MODE=write` (`write | shadow`)
- `MEMORY_DAILY_LOG_MIN_CONFIDENCE=0.65`
- `MEMORY_DAILY_LOG_MAX_PER_TURN=3`
- `MEMORY_DAILY_LOG_MAX_PER_DAY=30`

`shadow` mode means evaluate and log decisions, but do not persist into official memory.

## 7. Data Additions (minimal)

For daily log quality and auditability, add optional fields to memory item metadata:
- `dayKey` (YYYY-MM-DD)
- `dedupeKey`
- `hitCount`
- `firstSeenAt`
- `lastSeenAt`
- `sourceType` (`explicit` | `daily-log`)

These are additive and backward-compatible.

## 8. Runtime Placement

Write should run after successful model turn completion:
- chat dispatcher success path
- internal run success path

Do not write on:
- aborted runs
- failed runs

## 9. Reliability Requirements

- Keep fail-open behavior for memory writes.
- Use atomic file write for `state.json` (tmp + rename).
- Keep single-process deployment for local file store.

## 10. Observability

Minimum counters:
- `memory_write_attempt_total`
- `memory_write_accepted_total`
- `memory_write_rejected_total`
- `memory_write_deduped_total`
- `memory_write_skipped_quota_total`

Attach rejection reason labels, e.g. `low_confidence`, `small_talk`, `duplicate`, `quota`.

## 11. Rollout

Phase A: shadow mode (1 week)
- Evaluate decisions and rejection reasons
- Tune thresholds and quotas

Phase B: write mode
- Enable persistence
- Monitor correction rate (`forget` usage) and recall usefulness

## 12. Alignment Notes

This policy aligns with the existing memory plugin design docs:
- high-signal writes only
- strict write gate
- fail-open operation

It also aligns with OpenClaw-style memory philosophy at a high level:
- durable memory is curated
- daily memory is selective
- not all conversation text becomes memory

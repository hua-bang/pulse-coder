# Memory Plugin Product Design

Status: draft
Owner: platform
Last updated: 2026-02-19

## 1. Problem Statement

Coding agents lose useful context across sessions. Users repeatedly restate preferences, project rules, and prior fixes. This causes slower delivery and inconsistent behavior.

We need a memory capability that improves continuity without introducing memory coupling into Engine SDK.

## 2. Product Vision

Provide a memory layer that feels invisible when correct and fully controllable when needed.

- Invisible: agent recalls relevant context automatically.
- Controllable: user can inspect, pin, delete, or disable memory.
- Trustworthy: no hidden permanent storage of full conversations by default.

## 3. Product Goals

- Improve cross-session task continuation.
- Reduce repeated user instructions.
- Persist stable project constraints and user preferences.
- Reuse validated troubleshooting paths.
- Keep latency and cost predictable.

## 4. Non-goals (MVP)

- Full transcript archival as memory.
- Autonomous planning system built on memory.
- Mandatory vector-database deployment.
- Auto-memory that users cannot inspect or override.

## 5. Personas and Jobs-to-be-done

### 5.1 Solo Developer

- Wants fast session resume with minimal prompt setup.
- Needs personal response style preferences remembered.

### 5.2 Team Maintainer

- Needs coding conventions and review constraints consistently applied.
- Wants memory entries that are auditable by teammates.

### 5.3 Platform Integrator

- Needs a memory layer that can be turned on per host product.
- Requires strict tenant boundaries and cost controls.

## 6. Core Use Scenarios

1. Resume previous task:
- User says "continue the auth refactor from yesterday".
- Agent recalls task state, touched modules, and pending actions.

2. Project conventions:
- Agent remembers package manager, lint rules, and commit style.
- User no longer repeats these rules every session.

3. Incident reuse:
- CI failure recurs; agent recalls prior successful fix path.
- Troubleshooting loop shortens.

4. Interaction preferences:
- Agent remembers user prefers concise output and numbered next steps.

## 7. Product Principles

- User-first control: memory is always inspectable and deletable.
- High-signal storage: only distilled facts, decisions, and preferences.
- Safety: sensitive information is redacted before persistence.
- Cost discipline: remote memory calls are conditional and throttled.
- Progressive capability: local-only works first, remote optional.

## 8. Feature Scope

### 8.1 MVP

- Context recall before model call.
- Distilled memory write after turn/task.
- Memory management commands:
  - `/memory`
  - `/memory pin <id>`
  - `/memory forget <id>`
  - `/memory off`
- Attribution in injected memory snippets.

### 8.2 V1

- Hybrid recall (keyword + semantic).
- Project/session/global scope filters.
- Memory quality signals (confidence, importance).
- Lightweight memory compaction.

### 8.3 Later

- Shared team memory views.
- Policy templates by workspace type.
- Active memory health checks and automatic cleanup policies.

## 9. UX Design

### 9.1 Recall Transparency

When memory is used, show a compact indicator:
- count of injected items
- why these items were selected
- command hint to inspect or disable

### 9.2 Memory Inspection

`/memory` should show:
- id, type, scope, short summary
- source and updated time
- confidence and pin status

### 9.3 Recovery from Bad Memory

Users can immediately:
- forget one entry (`/memory forget <id>`)
- disable memory in current session (`/memory off`)

## 10. Success Metrics

Primary:
- repeated instruction rate down >= 30%
- cross-session continuation success up >= 20%

Performance:
- local recall p95 < 80 ms
- remote recall p95 < 300 ms

Efficiency:
- remote recall executed in <= 40% of turns
- remote writes <= 15 per 100 turns

Quality:
- memory correction rate (forget/edit) <= 10%
- useful recall feedback >= 70%

## 11. Rollout Plan

Phase 1 (local MVP):
- SQLite + keyword recall
- basic write extraction and management commands

Phase 2 (hybrid quality):
- optional embeddings and hybrid ranking
- dedupe improvements and topic-aware reuse

Phase 3 (remote scale):
- remote adapter and async flush queue
- tenant controls and policy settings

Phase 4 (optimization):
- A/B tuning of recall and write gates
- telemetry dashboard and quality loops

## 12. Risks and Mitigations

1. Memory pollution:
- mitigation: strict write gate, dedupe, confidence thresholds

2. Privacy incidents:
- mitigation: redaction, denylist, explicit forget APIs, audit logs

3. Cost spikes:
- mitigation: local-first retrieval, query cache, remote call quotas

4. Latency regressions:
- mitigation: asynchronous writes, bounded recall budget, fallback paths

## 13. Open Product Decisions

- Should pinned project rules be injected every turn or only when relevant?
- Should users be allowed to edit memory entries directly in MVP?
- Which default retention windows per memory type are safest?
- Should team-shared memory be enabled by default or opt-in?

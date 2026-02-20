# Memory Plugin Design

Status: draft
Owner: platform
Last updated: 2026-02-19

## 1. Product Design

### 1.1 Background

The agent should preserve useful context across sessions without turning Engine SDK into a stateful, memory-aware core. Memory will be implemented as a host-side plugin.

### 1.2 Product Goals

- Improve continuity across sessions and task switches.
- Reduce repeated user instructions (preferences, project rules, known fixes).
- Keep Engine SDK generic and stateless.
- Control latency and cost through conditional recall/write policies.

### 1.3 Non-goals (MVP)

- No full conversation archival as memory.
- No mandatory vector database dependency.
- No knowledge graph or autonomous long-term planning system.

### 1.4 Primary User Scenarios

- Resume unfinished tasks from previous sessions.
- Persist project conventions (tooling, style rules, commit patterns).
- Reuse proven troubleshooting paths for recurring failures.
- Preserve user interaction preferences (output style, workflow order).

### 1.5 Core Product Principles

- Opt-in and transparent: users can inspect and delete memory.
- High-signal only: store distilled facts/decisions, not raw chat logs.
- Fail-open: memory failures never block core agent response.
- Local-first: prefer local storage and only call remote services when needed.

### 1.6 User-facing Features (MVP)

- Memory recall to enrich prompt context.
- Memory write-back from completed turns/tasks.
- Memory management commands:
  - `/memory` (list active and recent memory)
  - `/memory pin <id>`
  - `/memory forget <id>`
  - `/memory off` (session scoped)
- Basic source attribution for injected memory snippets.

### 1.7 Success Metrics

- Repeated instruction rate down >= 30%.
- Cross-session task continuation success up >= 20%.
- Additional p95 latency:
  - local recall < 80 ms
  - remote recall < 300 ms
- Remote write frequency <= 15 writes per 100 turns.

### 1.8 Rollout Plan

- Phase 1: local-only memory (SQLite + FTS).
- Phase 2: optional vector recall and hybrid ranking.
- Phase 3: remote memory adapter, async flush, tenant controls.
- Phase 4: A/B tuning and policy hardening.

## 2. Technical Design

### 2.1 Architectural Constraint

Engine SDK must not include memory-specific concepts. Memory is implemented entirely by host middleware and external adapters.

### 2.2 High-level Architecture

- Host Runtime
  - Manages session state, middleware chain, and command routing.
- Middleware Pipeline (generic)
  - `beforePrompt(ctx)`
  - `afterPrompt(ctx, output)`
  - `onToolResult(ctx, toolOutput)`
- Memory Plugin (host extension)
  - Recall, rank, inject, extract, deduplicate, write.
- Store Adapters
  - Local SQLite adapter (required for MVP).
  - Remote adapter (optional).
  - Hybrid adapter (local-first + remote fallback).
- Policy Engine
  - Recall Gate, Write Gate, Privacy Gate, Budget Gate.
- Telemetry
  - Recall hit/miss, added tokens, write count, dedupe ratio, latency.

### 2.3 Turn Lifecycle

1. User turn enters host runtime.
2. `beforePrompt` runs memory recall gates.
3. If enabled, plugin retrieves candidate memories and injects top results into prompt context.
4. Host calls Engine SDK with enriched context.
5. Response is returned to user immediately.
6. `afterPrompt` runs asynchronously to extract and persist high-value memory entries.
7. `onToolResult` can enrich memory extraction for verified outcomes (for example: successful fix path).

### 2.4 Gating and Frequency Control

Memory plugin is evaluated each turn, but backend calls are conditional.

Recall trigger examples:
- Session start.
- Topic change.
- User references prior work (for example: "continue previous task").
- Cache stale or low-confidence local results.

Recall skip examples:
- Short acknowledgements.
- Tool-only machine turns.
- Fresh cache hit in same topic window.

Write trigger examples:
- Explicit decisions and constraints.
- Validated troubleshooting outcomes.
- Stable user preferences.

Write skip examples:
- Casual conversation.
- Low-confidence extraction.
- Near-duplicate entries.

### 2.5 Data Model

`MemoryItem`:

- `id`
- `tenantId`
- `projectId`
- `sessionId`
- `userId`
- `scope` (`session | project | global`)
- `type` (`preference | rule | decision | fact | fix | todo`)
- `content`
- `summary`
- `tags[]`
- `keywords[]`
- `embedding` (optional)
- `confidence` (0..1)
- `importance` (0..1)
- `source`
- `createdAt`
- `lastAccessedAt`
- `ttl`
- `pinned`
- `deleted`

### 2.6 Retrieval and Ranking

Recall strategy:
- Keyword recall via FTS.
- Optional semantic recall via embedding index.
- Recency bonus.

Hybrid score (default):
- `0.55 * semantic + 0.35 * keyword + 0.10 * recency`

Injection constraints:
- `topK = 3..8`
- token budget cap per turn
- minimum score threshold

### 2.7 Caching and Performance

- Query fingerprint cache (TTL 2-5 minutes).
- Topic window reuse (3-5 turns).
- Local-first retrieval; remote only on misses or low scores.
- Async batched writes with retry and backoff.
- Idempotency key: `sessionId + turnId + hash(content)`.

### 2.8 Security and Privacy

- Store distilled memory, not full raw transcripts by default.
- Redact sensitive patterns before persistence.
- Support denylist by path/tag/project.
- Provide explicit forget APIs and audit events.
- Enforce tenant isolation in remote adapter.

### 2.9 Reliability and Degradation

- Fail-open: recall/write errors do not block main turn.
- If embedding provider fails, fallback to keyword-only recall.
- If remote store fails, queue local and retry asynchronously.

### 2.10 Suggested Interfaces

```ts
export type Middleware = {
  beforePrompt?(ctx: TurnContext): Promise<TurnContext>;
  afterPrompt?(ctx: TurnContext, out: TurnOutput): Promise<void>;
  onToolResult?(ctx: TurnContext, tool: ToolOutput): Promise<void>;
};

export interface MemoryStore {
  search(query: SearchQuery): Promise<MemoryHit[]>;
  upsert(items: MemoryItem[]): Promise<void>;
  forget(ids: string[]): Promise<void>;
  compact(policy: CompactPolicy): Promise<void>;
}
```

### 2.11 Suggested Project Layout

- `docs/memory-plugin-design.md`
- `src/middleware/memory-plugin.ts`
- `src/memory/policy/*.ts`
- `src/memory/store/sqlite-store.ts`
- `src/memory/store/remote-store.ts`
- `src/memory/extractors/*.ts`
- `src/commands/memory/*.ts`

### 2.12 Implementation Milestones (4 weeks)

Week 1:
- Middleware hooks in host runtime.
- SQLite schema + FTS recall.
- Basic prompt injection.

Week 2:
- Memory extraction and dedupe.
- TTL and pin/forget operations.
- `/memory` command basics.

Week 3:
- Optional embeddings and hybrid ranking.
- Async write queue and retry policy.
- Local/remote hybrid adapter.

Week 4:
- Telemetry dashboard.
- A/B policy tuning.
- Load tests and rollout guardrails.

### 2.13 Open Decisions

- Canonical extraction strategy: rule-based first, model-assisted later, or hybrid.
- Embedding provider default and fallback policy.
- Remote storage SLO and cost limits by tenant.
- Retention defaults per scope type.

# Memory Plugin Technical Design

Status: draft
Owner: platform
Last updated: 2026-02-19

## 1. Technical Objective

Implement memory entirely outside Engine SDK using host middleware, so the core engine remains memory-agnostic, stateless, and portable.

## 2. Architectural Constraints

- No memory-specific APIs in Engine SDK.
- Host runtime owns middleware pipeline and memory orchestration.
- Memory failures must not block response generation.
- Default deployment must work without external vector infrastructure.

## 3. System Architecture

Components:
- Host Runtime
- Middleware Chain
- Memory Plugin
- Policy Engine
- Memory Store Adapters
- Embedding Adapter (optional)
- Cache Layer
- Telemetry Pipeline

Data flow:
1. User turn enters host runtime.
2. `beforePrompt` middleware decides recall behavior.
3. Memory candidates are retrieved, ranked, and injected.
4. Host invokes Engine SDK with enriched prompt.
5. User receives response.
6. `afterPrompt` extracts high-value memory and writes asynchronously.
7. Optional `onToolResult` augments write quality for verified outcomes.

## 4. Middleware Contracts

```ts
export type Middleware = {
  beforePrompt?(ctx: TurnContext): Promise<TurnContext>;
  afterPrompt?(ctx: TurnContext, out: TurnOutput): Promise<void>;
  onToolResult?(ctx: TurnContext, tool: ToolOutput): Promise<void>;
};
```

Memory plugin implementation lives in host code and is one middleware in this chain.

## 5. Memory Store Contracts

```ts
export interface MemoryStore {
  search(query: SearchQuery): Promise<MemoryHit[]>;
  upsert(items: MemoryItem[]): Promise<void>;
  forget(ids: string[]): Promise<void>;
  compact(policy: CompactPolicy): Promise<void>;
}
```

Adapters:
- `SqliteMemoryStore` (MVP baseline)
- `RemoteMemoryStore` (optional)
- `HybridMemoryStore` (local-first, remote fallback)

## 6. Core Data Model

`MemoryItem`
- `id: string`
- `tenantId: string`
- `projectId: string`
- `sessionId: string`
- `userId: string`
- `scope: "session" | "project" | "global"`
- `type: "preference" | "rule" | "decision" | "fact" | "fix" | "todo"`
- `content: string`
- `summary: string`
- `tags: string[]`
- `keywords: string[]`
- `embedding?: number[]`
- `confidence: number`
- `importance: number`
- `source: string`
- `createdAt: string`
- `lastAccessedAt: string`
- `ttl?: string`
- `pinned: boolean`
- `deleted: boolean`

## 7. Read Path (Recall)

### 7.1 Recall Gate

Evaluate if recall should run:
- run: session start, topic shift, explicit historical reference
- skip: short acknowledgements, tool-only turns, fresh cache hit

### 7.2 Candidate Retrieval

- keyword retrieval from SQLite FTS
- optional semantic retrieval using embeddings
- optional recency shortlist from recent memory window

### 7.3 Ranking and Selection

Default ranking formula:
- `score = 0.55 * semantic + 0.35 * keyword + 0.10 * recency`

Selection constraints:
- `topK` between 3 and 8
- token budget cap
- minimum score threshold

### 7.4 Prompt Injection

Inject memory snippets into structured context block:
- short summary
- source attribution
- reason for retrieval

## 8. Write Path (Persistence)

### 8.1 Extraction

Extract candidates from turn output and optional tool results:
- decisions
- preferences
- reusable fixes
- stable project constraints

### 8.2 Write Gate

Reject low-value writes:
- small talk
- low-confidence extraction
- duplicate or near-duplicate content

### 8.3 Deduplication and Upsert

- lexical dedupe (hash/simhash)
- semantic dedupe (embedding similarity threshold)
- upsert updates `lastAccessedAt` and confidence signals

### 8.4 Async Commit

- enqueue writes after response delivery
- batch writes for throughput
- retry with exponential backoff
- preserve idempotency using turn-scoped key

## 9. Caching and Frequency Control

- query fingerprint cache TTL: 2-5 minutes
- topic-window result reuse: 3-5 turns
- remote recall only when local confidence is insufficient
- target remote call profile:
  - reads: 20-40% turns
  - writes: 5-15% turns

## 10. Privacy and Security

- persist distilled entries, not full raw transcript by default
- redact secrets and PII before write
- enforce denylist rules (path/tag/project)
- implement explicit forget and audit events
- remote adapter must enforce tenant-level isolation

## 11. Reliability and Degradation

- fail-open on all memory errors
- fallback to keyword-only recall if embeddings unavailable
- buffer writes locally when remote unavailable
- background retry worker restores consistency

## 12. Observability

Required metrics:
- recall attempts, hits, misses
- injected memory count and token cost
- write attempts, accepted, rejected, deduped
- p50/p95 latency by store adapter
- memory correction events (`forget`, `off`, unpin)

Recommended tracing:
- turn-level recall decision reason
- selected memory ids and ranking scores
- write gate rejection reasons

## 13. Suggested Code Layout

- `src/middleware/memory-plugin.ts`
- `src/memory/policy/recall-gate.ts`
- `src/memory/policy/write-gate.ts`
- `src/memory/policy/privacy-gate.ts`
- `src/memory/store/sqlite-store.ts`
- `src/memory/store/remote-store.ts`
- `src/memory/store/hybrid-store.ts`
- `src/memory/extractors/turn-extractor.ts`
- `src/memory/extractors/tool-extractor.ts`
- `src/commands/memory/list.ts`
- `src/commands/memory/forget.ts`
- `src/commands/memory/pin.ts`

## 14. Testing Strategy

Unit tests:
- gate decisions
- ranking formula correctness
- dedupe behavior
- redaction rules

Integration tests:
- middleware lifecycle across a full turn
- local-only mode behavior
- remote fallback behavior
- async queue retry and idempotency

Load tests:
- recall p95 under target concurrency
- async write queue saturation and recovery

## 15. Four-week Delivery Plan

Week 1:
- middleware integration in host runtime
- sqlite schema and keyword recall
- minimal injection pipeline

Week 2:
- extraction + write gate + dedupe
- `/memory` list/forget/pin commands
- ttl and compaction baseline

Week 3:
- optional embeddings + hybrid ranking
- async queue + retry/backoff
- hybrid store adapter

Week 4:
- telemetry instrumentation
- policy A/B tuning
- load testing and rollout guardrails

## 16. Open Technical Decisions

- rule-based extraction only vs model-assisted extraction
- embedding provider defaults and fallback matrix
- retention defaults per type and scope
- remote SLO and tenant quota policy

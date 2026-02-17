# Pulse Coder Engine Architecture Docs (English)

This document set is translated and adapted from `../zh`, aligned with the current implementation in `packages/engine/src`.

Goals:
- Provide an architecture view that maps directly to code.
- Support future iteration, refactoring, and test planning.
- Help new contributors build understanding quickly in a fixed reading order.

## Recommended Reading Order

1. `01-engine-overview-and-goals.md`
2. `02-runtime-lifecycle-and-engine-run.md`
3. `03-agent-loop-core.md`
4. `04-llm-adapter-and-prompt.md`
5. `05-context-compaction-strategy.md`
6. `06-tool-system.md`
7. `07-plugin-system.md`
8. `08-built-in-plugins.md`
9. `09-config-and-operations.md`

## Scope

- ✅ Covered: `Engine`, `loop`, `ai`, `context`, `tools`, `plugin`, `built-in`, `config`
- ⚠️ Some areas are currently placeholders/light implementations:
  - The user config plugin “apply config” stage is still mostly scaffold/logging.
  - Several tools still use sync I/O (`fs.*Sync`, `execSync`).

## Code Baseline

- Source root: `packages/engine/src`
- Primary entry: `packages/engine/src/Engine.ts`
- Public exports: `packages/engine/src/index.ts`

## Maintenance Notes

After architecture-related code changes, update at least:
- Runtime flow changes: `02`, `03`
- Plugin/hook changes: `07`, `08`
- Model/prompt/context policy changes: `04`, `05`
- Env/default policy changes: `09`

---

Suggested next enhancements:
1. Add ADR sections to each chapter.
2. Add sequence diagrams to `03/07/08` for design review efficiency.

> Last synced from zh: 2026-02-17

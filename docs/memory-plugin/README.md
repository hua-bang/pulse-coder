# Memory Plugin Docs

This folder contains the detailed design for the memory system implemented as a host-side plugin, while Engine SDK remains memory-agnostic.

## Documents

- `docs/memory-plugin/product-design.md`
  - Product goals, user scenarios, feature scope, UX, metrics, and rollout.
- `docs/memory-plugin/technical-design.md`
  - Architecture, middleware contracts, data model, retrieval/write pipelines, security, and operations.
- `docs/memory-plugin/memory-production-v1.md`
  - Practical production write policy for explicit long-term memory and selective daily-log memory.

## Design Principles

- Engine SDK should not include memory-specific abstractions.
- Memory capability is injected by host middleware and adapters.
- Local-first and fail-open behavior are mandatory.
- Memory must be inspectable, controllable, and deletable by users.

## Related Work

- Existing draft doc in app scope has been superseded by this folder-level split design.

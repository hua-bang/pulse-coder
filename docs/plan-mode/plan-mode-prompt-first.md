# Plan Mode (Prompt-first) Design

## Goal
Implement a minimal Plan Mode for the coding agent with prompt-level restrictions only:
- In `planning` mode, the agent should primarily read, analyze, and produce plans.
- The agent should avoid write/execute behavior through system prompt constraints.
- Runtime tool hard-blocking is intentionally deferred to a later phase.

This document defines a low-cost MVP that is compatible with a future upgrade to hard tool gating.

## Scope
In scope (now):
- Mode-aware prompt strategy (`planning` vs `executing`).
- Tool metadata model that can be injected into prompts.
- Intent-based transition from planning to executing via user language (e.g., "开始执行").
- Basic observability for prompt violations (model attempted disallowed tools).

Out of scope (later):
- Runtime enforcement that blocks tool calls by mode.
- Security-grade policy engine and destructive command filtering.
- Full approval workflow UI.

## Product Behavior
### Planning Mode
- Primary behavior: inspect codebase, gather context, decompose tasks, propose execution plan.
- Prompt must explicitly prohibit write/edit/execute-oriented tools.
- If user requests implementation, agent should either:
  1) Ask for execution authorization, or
  2) If intent is explicit, transition to executing mode and proceed.

### Executing Mode
- Prompt allows implementation behavior and tool usage for code changes.
- Agent follows the approved/proposed plan and updates progress.

## Mode State
Use a simple two-state model:
- `planning`
- `executing`

Recommended defaults:
- Start sessions in `planning` for complex tasks.
- Start sessions in `executing` for simple fix requests (optional heuristic).

## Prompt Strategy
Maintain two system prompt profiles.

### Planning Prompt Requirements
Must include:
- Role objective: "analyze and plan first".
- Explicit disallowed actions in this mode (write/edit/exec classes).
- Instruction to provide a concrete plan format:
  - goals
  - assumptions
  - steps
  - risks
  - validation approach
- Transition rule:
  - If user explicitly authorizes execution, switch to `executing`.

Example policy snippet for planning prompt:
- "You are in PLANNING mode. Focus on reading, analysis, and plan generation. Do not perform code-modifying or command-execution actions in this mode. If the user explicitly asks to start implementation, acknowledge the mode switch and then proceed in EXECUTING mode."

### Executing Prompt Requirements
Must include:
- Follow plan steps before broad exploration.
- Make targeted edits and keep changes scoped.
- Report what changed and how it was verified.

## Tool Metadata (Prompt Injection Only)
Define tool metadata once, even before runtime gating.

Suggested shape:

```ts
export type ToolMeta = {
  name: string;
  category: "read" | "search" | "write" | "execute" | "other";
  risk: "low" | "medium" | "high";
  description: string;
  examples?: string[];
};

export type ModePolicy = {
  mode: "planning" | "executing";
  allowedCategories: ToolMeta["category"][];
  disallowedCategories: ToolMeta["category"][];
  notes?: string;
};
```

For MVP, this policy is used to render prompt text only.

## Intent-Based Transition (No Manual Mode Command Required)
Allow user language to switch from planning to executing.

### Detection Layers
1. Rule-based keyword matching (high precision)
2. Optional LLM intent classifier fallback

Suggested intent labels:
- `PLAN_ONLY`
- `EXECUTE_NOW`
- `UNCLEAR`

Suggested explicit triggers (zh/en examples):
- "开始执行"
- "按这个计划做"
- "可以改代码了"
- "直接实现"
- "go ahead"
- "proceed"
- "implement it"

Transition behavior:
- If `EXECUTE_NOW`, set state to `executing` and emit acknowledgment.
- Otherwise stay in `planning`.

## Observability (Important Even in Prompt-only Phase)
Log the following events:
- `mode_entered` (planning/executing)
- `execution_intent_detected`
- `mode_switched_by_intent`
- `disallowed_tool_attempt_in_planning` (soft violation)

Why this matters:
- You can quantify prompt adherence.
- You get baseline data before introducing hard runtime policy.

## Known Risks (Prompt-only)
- Model may still call disallowed tools under pressure/context drift.
- Safety depends on instruction following, not system guarantees.
- Different models vary in compliance.

Mitigations in this phase:
- Keep planning prompt short, explicit, and repetitive on constraints.
- Add self-check instruction before each tool call in planning mode.
- Track violations for follow-up hardening.

## Upgrade Path (Phase 2)
When ready, add runtime gating using the same `ModePolicy` metadata:
- Intercept tool calls.
- Deny disallowed categories in `planning`.
- Return structured error code (example: `TOOL_BLOCKED_BY_MODE`).

Because metadata is already structured, this becomes an implementation change, not a redesign.

## MVP Checklist
- [ ] Add mode state to session context
- [ ] Implement planning/executing prompt templates
- [ ] Inject tool metadata and mode policy text into system prompt
- [ ] Add intent detection for execution transition
- [ ] Add mode-switch acknowledgment response
- [ ] Add soft-violation observability events
- [ ] Document known limitations

## Acceptance Criteria
- In planning mode, agent output is predominantly analysis/plan content.
- Agent transitions to executing mode on explicit user authorization language.
- Prompt includes clear mode-specific tool guidance.
- Soft violations are logged for later policy hardening.

## Notes
This MVP intentionally optimizes for speed of adoption and low implementation cost.
It is not a security boundary. Treat it as behavior shaping before enforcement.

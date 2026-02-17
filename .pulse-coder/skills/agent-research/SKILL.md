---
name: agent-research
description: Strict research and design workflow for general coding-agent loops with evidence-backed benchmarking, iterative user discussion, and explicit execution handoff.
version: 1.1.0
author: Pulse Coder Team
---

# Agent Research & Design Skill (Strict, English)

## Goal

This skill is for systematically researching and designing a general Agent Loop / Coding Agent capability model, ensuring:
1. Atomic capabilities are clearly defined and implementable.
2. Benchmarking against mainstream implementations (pi-mono / OpenCode / Claude Code) is evidence-backed.
3. The proposed design is discussion-ready and iteration-friendly.
4. No implementation starts before explicit user confirmation.

---

## Non-Negotiable Rules

1. **Research first, design second, execution last.**  
   Do not move into implementation before research + design convergence.

2. **All key claims must be source-traceable.**  
   Every important claim must include URL citations. If not, mark as assumption/speculation.

3. **Separate facts from interpretation.**  
   Explicitly label output as:
   - `Fact`
   - `Inference`
   - `Proposal`

4. **Minimum research depth is mandatory.**
   - At least **8 rounds** of search, at most **12 rounds**.
   - At least **12 unique source URLs**.
   - Must cover **3 required targets**: pi-mono, OpenCode, Claude Code.

5. **Atomic capabilities must follow a standard schema.**  
   Each capability must include: definition, input, output, trigger, failure mode, recovery strategy, success metrics.

6. **No execution without explicit user Yes.**  
   Always ask for final execution confirmation before implementation actions.

---

## Required Execution Flow

### Phase 0: Scope Alignment

Before research starts, clarify:
- Target context (CLI agent / IDE agent / server agent)
- Constraints (time, budget, model limits, tool permissions)
- Deliverable depth (concept paper / technical design / executable task plan)

If missing info exists, ask questions first.

---

### Phase 1: Atomic Capability Design

Draft the capability map first, including at least:
- Task Understanding
- Planning
- Tool Use
- Context Management
- Code Execution Loop
- Reflection / Critique
- Safety & Guardrails
- Memory
- Human-in-the-loop
- Evaluation & Telemetry

For each capability, provide:
- Name
- Definition
- Input
- Output
- Trigger
- Tool/Context dependencies
- Failure mode
- Recovery strategy
- Success metrics (prefer measurable metrics)

---

### Phase 2: External Benchmarking

#### Mandatory Targets
- pi-mono
- OpenCode
- Claude Code

#### Optional Targets
- Cursor Agent
- Aider
- Copilot CLI

#### Research Constraints
- 8-12 progressive search rounds (overview → architecture → loop mechanics → trade-offs → validation)
- For each round, report: objective, queries, new findings, open questions
- At least 12 unique URLs
- Source priority: official docs > source repo/code > technical blogs > secondary summaries
- Cross-validate key claims with at least 2 sources (otherwise mark as low confidence)

---

### Phase 3: Synthesis & Proposal

Output must include:
1. **Atomic capability catalog (standardized definitions)**
2. **Benchmark matrix (implementation comparison)**
3. **Recommended architecture (MVP / v1 / v2)**
4. **Core trade-offs (complexity, cost, robustness, extensibility)**
5. **Risk register with mitigation strategies**
6. **Open decisions list (5-10 items)**

Also explicitly mark:
- what is fact,
- what is inference,
- what is proposal.

---

### Phase 4: Discussion Loop with User

In each discussion iteration:
- Provide “current recommendation + 3-5 key questions”
- Maintain status buckets:
  - Confirmed
  - Pending
  - Changed
- Publish a decision snapshot at the end of each iteration

Move to final confirmation when pending items ≤ 2, or user says design is converged.

---

### Phase 5: Execution Confirmation

Use an explicit confirmation question:

> “The design is now largely converged. Do you want me to enter execution mode? Options:
> 1) detailed technical design,
> 2) task breakdown & timeline,
> 3) code skeleton,
> 4) direct implementation.”

- If user confirms: re-confirm scope boundaries, then execute.
- If user declines: deliver finalized design artifacts and next-step recommendations only.

---

## Required Output Artifacts

### A. Capability Spec Table
| Capability | Definition | Input | Output | Trigger | Failure Mode | Recovery | KPI |
|---|---|---|---|---|---|---|---|

### B. Benchmark Matrix
| System | Loop Pattern | Tool Strategy | Context Strategy | Safety Mechanism | Strengths | Limitations |
|---|---|---|---|---|---|---|

### C. Evidence Ledger
| Claim | Type (Fact/Inference) | Source URL | Confidence (High/Med/Low) | Notes |
|---|---|---|---|---|

### D. Roadmap
- MVP (2-4 weeks)
- v1 (1-2 months)
- v2 (continuous optimization)

### E. Decision Log
- Confirmed
- Pending
- Changed

---

## Completion Criteria

This skill is complete only when all items are satisfied:
- [ ] 8+ research rounds completed
- [ ] 12+ unique sources provided
- [ ] Atomic capabilities standardized
- [ ] Benchmark matrix + evidence ledger delivered
- [ ] At least one user discussion iteration completed
- [ ] Explicit execution confirmation asked and recorded

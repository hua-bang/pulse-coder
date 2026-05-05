---
name: requirement-to-mr
description: Explicitly authorized workflow that converts a requirement into an implemented change, validation evidence, commit, push, and MR for this Pulse Coder project.
description_zh: 面向当前 Pulse Coder 项目的显式授权低交互流程：用户明确要求后，将需求实现、校验、提交、推送并产出 MR。
version: 1.0.0
author: Pulse Coder Team
---

# Requirement to MR Skill

This skill turns a short product/engineering request into a reviewable MR with minimal back-and-forth. It is optimized for the current Pulse Coder TypeScript `pnpm` monorepo.

## When to Use

Use this skill **only when the user explicitly authorizes an end-to-end implementation workflow that includes commit/push/MR or PR creation**.

Valid triggers include one of these patterns:

1. The user names this skill directly:
   - “用 requirement-to-mr 做这个需求”
   - “按 requirement-to-mr 流程执行”
2. The user explicitly asks for implementation plus MR/PR handoff:
   - “帮我实现这个需求，改完提交并提 MR”
   - “修一下这个 bug，验证后提 PR”
   - “改完 commit、push 并创建 MR”
3. The user explicitly grants low-interaction execution and asks for MR/PR output:
   - “按低交互流程直接实现并出 MR”
   - “这个需求你自己落地，最后提 PR”

The trigger must include either:

- explicit skill name / low-interaction workflow authorization, or
- both implementation intent and MR/PR/commit/push handoff intent.

## When Not to Use

Do **not** trigger this skill merely because the user asks to implement, support, inspect, or plan something.

Examples that should **not** trigger this skill by themselves:

- “帮我看看这个需求怎么做”
- “支持一下 X”
- “分析一下能不能做”
- “这个项目后面要怎么推进”
- “帮我改一下 X”
- “实现一下 X”

For those cases, use ordinary coding flow, `project-roadmap`, `refactor`, or `code-review` as appropriate. Ask for explicit MR/PR handoff authorization before committing, pushing, or creating an MR.

## Operating Mode

Default behavior after valid trigger: **one-time authorization, then autonomous execution**.

The user should not need to confirm every step. Once the skill is explicitly triggered, proceed directly from requirement intake to implementation, validation, commit, push, and MR creation, unless a hard stop condition is met.

### Interaction Budget

Ask at most **one** clarification question before starting, and only when the answer materially changes the implementation.

If the requirement is understandable but incomplete, proceed with explicit assumptions instead of asking.

## Hard Stop Conditions

Pause and ask for confirmation when any of these are true:

1. **Destructive or irreversible operation**: deleting user data, rewriting history, force-push, migrations that may lose data.
2. **Security/secrets risk**: handling private keys, tokens, credentials, production secrets, or broad permission changes.
3. **Unowned dirty worktree**: `git status --short` shows existing changes that are unrelated to this task and the user did not say they are yours.
4. **Production operation**: deploy, restart production services, modify live infra, rotate credentials.
5. **Requirement is too ambiguous to test**: no clear observable outcome can be inferred.
6. **MR cannot be created safely**: no remote, authentication failure, branch policy unknown, or current branch is protected and no branch creation is possible.

When blocked, report:

```md
Blocked: <reason>
Minimum decision needed: <one concrete question or action>
Safe next option: <what can be done without the decision>
```

## Current Project Defaults

Treat the repository as a TypeScript `pnpm` monorepo:

| Area | Default investigation path | Validation |
|---|---|---|
| Engine loop/tools/plugins | `packages/engine/src/` | `pnpm --filter pulse-coder-engine test`; `pnpm --filter pulse-coder-engine typecheck` |
| CLI | `packages/cli/src/` | `pnpm --filter pulse-coder-cli test`; `pnpm --filter pulse-coder-cli build` |
| Sandbox | `packages/pulse-sandbox/src/` | `pnpm --filter pulse-sandbox test` |
| Memory | `packages/memory-plugin/src/` | `pnpm --filter pulse-coder-memory-plugin test` |
| Remote server | `apps/remote-server/src/` | `pnpm --filter @pulse-coder/remote-server build` |
| Skills only | `.pulse-coder/skills/<name>/SKILL.md` | Check frontmatter and read generated file |
| Cross-package | Relevant package checks first | `pnpm run build` as final gate if practical |

Use repository conventions:

- TypeScript strict mode.
- 2-space indentation, semicolons, single quotes.
- `PascalCase` for classes/types, `camelCase` for functions/vars, `kebab-case` filenames.
- Keep diffs small and follow nearby code style.

## End-to-End Workflow

### 0. Initialize Execution Tracking

For multi-step work, use task tracking:

1. List existing active tasks.
2. Create focused tasks for intake, implementation, validation, and MR handoff.
3. Keep one primary task `in_progress`.
4. Mark blockers explicitly.

### 1. Protect the Worktree

Always run:

```bash
pwd
git status --short
git branch --show-current
git remote -v
```

Rules:

- If the worktree is clean, proceed.
- If dirty files are clearly from this same session/task, proceed and include them in the commit.
- If dirty files may belong to the user or another task, stop before editing and ask what to do.
- Never discard or overwrite uncommitted work unless explicitly instructed.

### 2. Parse the Requirement into an Executable Brief

Create a short internal brief before editing:

```md
Requirement brief:
- Goal:
- User-visible behavior:
- Likely area/package:
- Non-goals:
- Assumptions:
- Acceptance checks:
```

Keep it concise. Do not ask the user to approve the brief unless a hard stop condition applies.

### 3. Classify Scope

Use the smallest safe path:

| Scope | Examples | Default behavior |
|---|---|---|
| XS | docs, skill, config, small bug fix | Implement directly |
| S | one package, limited tests | Implement directly |
| M | multiple files/packages, clear interfaces | Implement in one focused MR if still reviewable |
| L | architecture change, migration, unclear behavior | Plan first; ask one decision question if needed |

Prefer an MR-sized slice over a broad rewrite. If the request is large, implement the smallest valuable slice and document follow-ups.

### 4. Branch Strategy

Before editing, inspect the current branch.

- If on `main` or `master`, create a new branch.
- If already on a feature/fix branch and the worktree is clean, use the current branch unless the user asked for a new branch.
- If the current branch name is unrelated to the requirement but clean, prefer creating a new branch.

Branch naming:

```text
feat/<short-kebab-goal>
fix/<short-kebab-bug>
docs/<short-kebab-topic>
chore/<short-kebab-maintenance>
```

If the `branch-naming` skill is available and naming is non-trivial, use it.

### 5. Minimal Targeted Discovery

Read only files needed for the requirement.

Recommended sequence:

1. Search for exact symbols, routes, command names, or package names from the requirement.
2. Read the smallest relevant files.
3. Inspect tests near those files.
4. Avoid broad exploration, generated output, `dist/`, `node_modules/`, local session stores, and private memory data.

### 6. Implement

Implementation rules:

- Make the smallest coherent change that satisfies acceptance checks.
- Preserve existing public APIs unless the requirement explicitly changes them.
- Add or update tests for behavior changes.
- Update docs or skill instructions when behavior is user-facing.
- Keep unrelated refactors out of the MR.
- Prefer targeted edits over wholesale rewrites.

### 7. Validate

Run the narrowest useful validation first, then broader checks only when justified.

Validation decision table:

| Change type | Minimum validation |
|---|---|
| Skill/docs only | Read generated file; verify YAML frontmatter has `name` and `description` |
| Unit behavior | Related package test or focused Vitest test |
| Type/interface change | Related package typecheck/build |
| Remote server behavior | `pnpm --filter @pulse-coder/remote-server build` plus relevant tests if present |
| Cross-package behavior | Targeted package checks, then `pnpm run build` if practical |

If validation fails:

1. Fix failures directly if clearly caused by this change.
2. Re-run the failed check.
3. If unrelated or environment-caused, report evidence and continue only if safe.

### 8. Review the Diff Before Commit

Run:

```bash
git diff --stat
git diff -- <relevant paths>
```

Check:

- Diff matches the requirement.
- No secrets, local paths, logs, generated junk, or unrelated files are included.
- Tests/docs are included when needed.

### 9. Commit, Push, and MR

Use the existing `git-workflow` and `mr-generator` skills when available.

Default sequence:

```bash
git status --short
git add -A
git commit -m "<type>: <short summary>"
git push -u origin HEAD
```

Commit message rules:

- Use Conventional Commits: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Keep the subject concise and specific.
- If useful, include bullet details in the commit body.

After a successful push:

1. Check whether an open PR/MR already exists for the branch.
2. If none exists, run `mr-generator` by default.
3. If automatic MR creation fails, provide the generated title/body and exact command for manual creation.

Expected MR body:

```md
## Summary
- <change 1>
- <change 2>

## Validation
- `<command>` ✅ / ⚠️ <result>

## Risk
- <main risk or "Low; scoped change">
```

### 10. Final Response

Keep the final response short and execution-oriented:

```md
已完成：<one-line outcome>

MR: <url or creation status>
Commit: <sha or branch>
验证：
- `<command>`: <result>

备注：
- <assumption, skipped check, or follow-up if any>
```

If no MR was created:

```md
代码已完成但 MR 未创建。
原因：<reason>
下一步：<exact command or decision needed>
```

## Autonomous Decision Heuristics

When the user gives only a short requirement after a valid trigger, infer using these rules:

1. Prefer fixing the root cause over adding a workaround, unless the workaround is the only MR-sized safe slice.
2. Prefer behavior covered by tests over undocumented behavior.
3. Prefer existing patterns in nearby code over introducing new abstractions.
4. Prefer package-local changes over cross-package coupling.
5. Prefer explicit errors and recoverable failure modes over silent failures.
6. Prefer small, reviewable MRs over large bundled changes.
7. If the task could be docs-only or code, choose code only when user-visible behavior requires it.
8. If multiple packages are plausible, start from the user-facing entrypoint and trace inward.

## Low-Interaction Clarification Templates

Use one of these only when needed:

```md
我可以继续，但有一个会影响实现范围的问题：<question>
如果你不补充，我将按这个默认假设执行：<assumption>。
```

```md
当前工作区已有未提交改动，可能不是本任务产生的。请确认：
A. 我可以一起纳入本次 MR
B. 我只改新需求相关文件
C. 先停止，等你处理工作区
```

## Completion Criteria

This skill is complete when all are true:

- The user explicitly authorized the requirement-to-MR flow.
- Requirement is implemented in the smallest safe MR-sized slice.
- Relevant validation was run or a clear reason is documented.
- Diff was reviewed for scope and secrets.
- Changes are committed and pushed, unless blocked.
- MR is created or manual MR instructions are provided.
- Final response includes MR/branch, validation evidence, and remaining risks.

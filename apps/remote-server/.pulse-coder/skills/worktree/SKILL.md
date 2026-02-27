---
name: worktree
description: Create and manage isolated git worktrees for parallel feature development on one machine
description_zh: Use one repo with multiple isolated work directories, ideal for parallel tasks across channels/threads
version: 1.3.0
author: Pulse Coder Team
---

# Worktree Skill

Use this skill to isolate changes across multiple tasks while keeping one shared repository history.

## When to Use

Use `worktree` when the user wants to:
- Develop multiple requirements in parallel on one machine
- Avoid frequent `stash` / branch switching in a single folder
- Keep one task in one isolated workspace

## Execution Contract

- Only create a new worktree when explicitly triggered (for example: `/skill worktree new ...`).
- If user did not ask for worktree operations, do not auto-create directories.
- Keep one task per worktree, one branch per worktree.
- Always resolve and use the git repository root before running worktree commands.
- After `new`, always return a context pin block so later agent messages know the exact work directory.

## Primary Interface

Use a single name for `new` (no required channel/thread arguments):

```text
/skill worktree new <work-name>
```

Example:
- `/skill worktree new feat-agent-team`

## Thread Context Pin (Required)

After `new`, always print a copyable context block:

```text
Context pinned
- workdir: <repo-root>/worktrees/wt-<slug>
- branch: <resolved-branch>
- verify: cd <repo-root>/worktrees/wt-<slug> && pwd && git branch --show-current && git status -sb
```

In each new channel/thread, user should paste one opening line:

```text
Current working directory: <repo-root>/worktrees/wt-<slug>
```

## Repo Root Resolution (Required)

Always anchor paths to the repo root so the skill works even when current shell path is a subdirectory.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$REPO_ROOT/worktrees"
```

## Defaults

- Base branch preference: `origin/main`
- Worktree root directory: `$REPO_ROOT/worktrees`
- Worktree directory prefix: `wt-`

Base branch fallback order:
1. `origin/main`
2. `origin/master`
3. `main`
4. `master`

## Name and Branch Rules

Convert `<work-name>` to slug:
- lowercase
- spaces and separators -> `-`
- keep only `a-z`, `0-9`, `-`
- collapse repeated `-`

Branch mapping:
- If slug starts with `feat-`, `fix-`, `docs-`, `chore-`, `refactor-`, `test-`, or `hotfix-`, convert first `-` to `/`.
  - Example: `feat-agent-team` -> `feat/agent-team`
- Otherwise default to `feat/<slug>`.
  - Example: `agent-team` -> `feat/agent-team`

Directory mapping:
- Directory: `$REPO_ROOT/worktrees/wt-<slug>`

## Commands

### 1) Create: `new`

Goal: create an isolated worktree + branch for one task.

```bash
# Required: one work name
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$REPO_ROOT/worktrees"
SLUG="<slug-from-work-name>"

# map slug to branch
if echo "$SLUG" | grep -Eq '^(feat|fix|docs|chore|refactor|test|hotfix)-'; then
  BRANCH="$(echo "$SLUG" | sed -E 's/^([a-z0-9]+)-/\1\//')"
else
  BRANCH="feat/$SLUG"
fi

git -C "$REPO_ROOT" fetch origin
mkdir -p "$WORKTREE_ROOT"

if git -C "$REPO_ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
  BASE_REF="origin/main"
elif git -C "$REPO_ROOT" show-ref --verify --quiet refs/remotes/origin/master; then
  BASE_REF="origin/master"
elif git -C "$REPO_ROOT" show-ref --verify --quiet refs/heads/main; then
  BASE_REF="main"
else
  BASE_REF="master"
fi

git -C "$REPO_ROOT" worktree add "$WORKTREE_ROOT/wt-$SLUG" -b "$BRANCH" "$BASE_REF"
```

If worktree already exists:
- Do not create again.
- Return existing path and branch.
- Still print the context pin block.

After creation, always print:
- absolute path
- branch name
- next commands (`cd`, `git status`)
- context pin block

### 2) List: `list`

Goal: show active worktrees and branches.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
git -C "$REPO_ROOT" worktree list
```

### 3) Sync: `sync`

Goal: keep a task branch updated with latest mainline.

Default strategy: `rebase`.

```bash
# Run in target worktree directory
git fetch origin
git rebase origin/main
```

If team prefers merge:
```bash
git fetch origin
git merge origin/main
```

If mainline is not `origin/main`, use the resolved fallback base ref.

### 4) Finish: `done`

Goal: safely clean up a finished task worktree.

Recommended flow:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$REPO_ROOT/worktrees"
SLUG="<slug-from-work-name>"
BRANCH="<resolved-branch-name>"

# Ensure task is merged first (from repo root)
git -C "$REPO_ROOT" branch --merged | grep "$BRANCH"

# Remove worktree
git -C "$REPO_ROOT" worktree remove "$WORKTREE_ROOT/wt-$SLUG"

# Delete branch (local)
git -C "$REPO_ROOT" branch -d "$BRANCH"

# Clean stale admin metadata
git -C "$REPO_ROOT" worktree prune
```

If branch is not merged:
- Do not force delete by default.
- Return clear warning and ask for explicit user confirmation before destructive cleanup.

## Safety Rules

- Never run `git reset --hard` in this skill.
- Never delete a worktree that has uncommitted changes unless user explicitly requests force behavior.
- Never reuse one worktree for multiple unrelated tasks.
- Never check out the same branch in multiple worktrees.

## Suggested UX Output

For `new`, return this compact block:

```text
Worktree created
- path: <repo-root>/worktrees/wt-<slug>
- branch: <resolved-branch>
- next: cd <repo-root>/worktrees/wt-<slug> && git status

Context pinned
- workdir: <repo-root>/worktrees/wt-<slug>
- branch: <resolved-branch>
- verify: cd <repo-root>/worktrees/wt-<slug> && pwd && git branch --show-current && git status -sb
```

For `sync`, return:

```text
Worktree synced
- path: <worktree-path>
- strategy: rebase
- base: origin/main (or fallback)
- result: up to date | rebased with N commits | conflicts detected
```

For `done`, return:

```text
Worktree cleaned
- removed: <repo-root>/worktrees/wt-<slug>
- branch: <resolved-branch> (deleted)
- pruned: yes
```

## Quick Reference

```bash
# Create
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_ROOT="$REPO_ROOT/worktrees"
git -C "$REPO_ROOT" fetch origin && mkdir -p "$WORKTREE_ROOT"
git -C "$REPO_ROOT" worktree add "$WORKTREE_ROOT/wt-<slug>" -b "<resolved-branch>" origin/main

# List
git -C "$REPO_ROOT" worktree list

# Sync (inside target worktree)
git fetch origin && git rebase origin/main

# Done
git -C "$REPO_ROOT" worktree remove "$WORKTREE_ROOT/wt-<slug>"
git -C "$REPO_ROOT" branch -d "<resolved-branch>"
git -C "$REPO_ROOT" worktree prune
```

---
name: git-workflow
description: Standard git workflow for handling changes on the current branch - add, commit, push, then auto-run MR generation when needed
description_zh: Standard git workflow on current branch with auto MR generation after push when needed.
version: 1.6.0
author: Pulse Coder Team
---

# Git Workflow Skill

This skill provides a streamlined git workflow for handling changes on the current branch without creating a new branch.

## Workflow Steps

### 1. Check current status
```bash
git status
```
Review the branch state and identify:
- Modified files
- Untracked files
- Staged files

### 2. Stage changes
```bash
git add -A
```
Default behavior:
- Always stage all current worktree changes (modified, untracked, and deletions) with `git add -A`
- This ensures commit includes both staged and unstaged changes from the working tree
- Use `git add <specific-files>` only when the user explicitly asks for partial commits

Important:
- `git commit` only includes staged content
- If anything remains unstaged, it will not be part of the commit

### 3. Commit changes
```bash
git commit -m "<type>: <short description>"
```

Recommended commit message format:
```text
<type>: <short description>

- <detail 1>
- <detail 2>
```

Common types:
- `feat` - new feature
- `fix` - bug fix
- `refactor` - refactor
- `docs` - documentation
- `style` - formatting/style only
- `test` - tests
- `chore` - tooling/build/maintenance

### 4. Push to remote
```bash
git push
```

### 5. Auto-run `mr-generator`
After a successful `git push`, if the current branch is not `master` or `main` and there is no existing open PR for this branch, run the `mr-generator` skill by default.
- If an open PR already exists for the current branch: skip `mr-generator`
- If branch is `master` or `main`: skip `mr-generator`

Suggested message:
```text
No open PR found for this branch. Running mr-generator by default.
```

### 6. If `mr-generator` does not create MR automatically
If `mr-generator` is in preview mode or unable to create, show the generated title/description and stop.

## Quick Flow

```bash
# End-to-end quick run
git status
git add -A
git commit -m "Describe your changes"
git push
# Then run mr-generator if needed
```

## Selective Flows

### Stage only specific paths
```bash
git add src/ docs/
git commit -m "feat: update core feature and docs"
git push
```

### Split into multiple commits
```bash
git add src/app.ts
git commit -m "feat: add new feature"
git add tests/
git commit -m "test: add corresponding tests"
git push
```

## Validation Checklist

After each run, verify:
1. `git status` - working tree is clean
2. `git log --oneline -3` - latest commits look correct
3. `git branch` - current branch is expected
4. After successful `git push`, confirm whether MR creation flow (`mr-generator`) is needed

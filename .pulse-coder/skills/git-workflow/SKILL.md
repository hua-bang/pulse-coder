---
name: git-workflow
description: Standard git workflow for handling changes on the current branch - add, commit, push, then optionally trigger MR generation
description_zh: Standard git workflow on current branch with optional handoff to mr-generator after push.
version: 1.4.0
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
git add <files...>
```
Choose based on context:
- `git add .` - stage all current changes
- `git add -A` - stage all changes including deletions
- `git add <specific-files>` - stage only selected files

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

### 5. Ask whether to run `mr-generator`
After a successful `git push`, ask the user whether to continue with `mr-generator`:
- If user confirms (for example: `y`, `yes`, `confirm`): invoke `mr-generator` skill
- If user declines (for example: `n`, `no`, `cancel`): finish workflow without extra actions

Suggested prompt:
```text
Git workflow completed. Do you want to run mr-generator now?
```

## Quick Flow

```bash
# End-to-end quick run
git status
git add .
git commit -m "Describe your changes"
git push
# Then ask whether to run mr-generator
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

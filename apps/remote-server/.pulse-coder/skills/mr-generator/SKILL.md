---
name: mr-generator
description: Automatically generate concise MR titles and descriptions based on current branch diff
description_zh: Automatically generate concise MR titles and descriptions from the current branch diff, then create MR via gh by default.
version: 1.3.0
author: Pulse Coder Team
---

# MR Generator Skill

This skill generates concise English MR titles and descriptions based on the diff between the current branch and the target branch (default: `origin/master`). It creates the MR via `gh` by default, unless preview mode is enabled or `--no-create` is passed.

## Core Capabilities

### 1. Intelligent diff analysis
- Analyze change types and scope
- Detect primary modules/features affected
- Extract key change points

### 2. Automatic title generation
- Prefix title with a change type (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`)
- Include the main module/feature
- Keep title within 50 characters when possible

### 3. Concise description generation
- List core change points
- Use bullet-point format
- Keep wording short and clear in English

### 4. Create MR by default
- Print generated title and description
- Create MR via `gh` unless `--preview` or `--no-create` is set
- Skip creation when an open PR already exists for the branch

## Required Execution Flow

1. Read diff between current branch and target branch (default: `origin/master`).
2. Generate an English MR title and description.
3. Print the proposed title and description.
4. If `--preview` or `--no-create` is set, stop after printing.
5. Otherwise, create the MR via `gh`:
   ```bash
   gh pr create --title "<generated_title>" --body "<generated_body>"
   ```

## Usage

### Basic usage
```bash
# Generate title/description, then create MR by default
./mr-generate.sh

# Set target branch (default: origin/master)
./mr-generate.sh --target origin/develop

# Preview only (generate, do not create MR)
./mr-generate.sh --preview

# Print only (no MR creation)
./mr-generate.sh --no-create
```

### Workflow integration
```bash
# Run after push
git push origin HEAD
./mr-generate.sh
```

## Title Generation Rules

### Change type mapping
- **Feature**: feat
- **Fix**: fix
- **Refactor**: refactor
- **Docs**: docs
- **Tests**: test
- **Config/Chore**: chore

### Module extraction
- Identify the main module based on file paths
- Prefer business-facing feature names
- Use concise technical terms

## Description Format

```text
Brief description of changes

- Key change 1
- Key change 2
- Impact or improvement
```

## Example Output

### Feature
**Title**: `feat: add user authentication with JWT`

**Description**:
```text
Implement secure user authentication using JWT tokens

- Add login/logout endpoints
- Implement token validation middleware
- Add user registration flow
- Update API documentation
```

### Bug Fix
**Title**: `fix: resolve login validation error`

**Description**:
```text
Resolve email validation issue in user login

- Fix regex pattern for email validation
- Add proper error handling for invalid formats
- Update unit tests for edge cases
```

### Refactor
**Title**: `refactor: simplify API response handling`

**Description**:
```text
Improve API response consistency and error handling

- Standardize response format across endpoints
- Add centralized error handling middleware
- Reduce code duplication in controllers
- Update test assertions
```

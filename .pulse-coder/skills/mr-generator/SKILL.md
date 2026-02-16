---
name: mr-generator
description: Automatically generate concise MR titles and descriptions based on current branch diff
description_zh: Automatically generate concise MR titles and descriptions from the current branch diff, then create MR via gh after user confirmation.
version: 1.2.0
author: Pulse Coder Team
---

# MR Generator Skill

This skill generates concise English MR titles and descriptions based on the diff between the current branch and the target branch (default: `origin/master`), and creates the MR via `gh` only after explicit user confirmation.

## Core Capabilities

### 1. Intelligent diff analysis
- Analyze change types and scope
- Detect primary modules/features affected
- Extract key change points

### 2. Automatic title generation
- Select suitable verbs by change type
- Include the main module/feature
- Keep title within 50 characters when possible

### 3. Concise description generation
- List core change points
- Use bullet-point format
- Keep wording short and clear in English

### 4. Create MR after user confirmation
- Show generated title and description first
- Ask for explicit confirmation before creating MR
- Run `gh` create command only when confirmed

## Required Execution Flow

1. Read diff between current branch and target branch (default: `origin/master`).
2. Generate an English MR title and description.
3. Present the proposed title and description to the user and ask for one explicit confirmation.
4. If user confirms (for example: `y`, `yes`, `confirm`):
   - Run `gh` to create the MR:
   ```bash
   gh pr create --title "<generated_title>" --body "<generated_body>"
   ```
5. If user does not confirm (for example: `n`, `no`, `cancel`):
   - Do not run `gh`.
   - Tell the user they can edit title/description and retry.

## Usage

### Basic usage
```bash
# Generate title/description, then create MR after confirmation
./mr-generate.sh

# Set target branch (default: origin/master)
./mr-generate.sh --target origin/develop

# Preview only (generate, do not create MR)
./mr-generate.sh --preview
```

### Workflow integration
```bash
# Run before MR creation
git push origin HEAD
./mr-generate.sh
```

## Title Generation Rules

### Change type mapping
- **Feature**: Add / Implement / Introduce
- **Fix**: Fix / Resolve / Correct
- **Refactor**: Refactor / Improve / Optimize
- **Docs**: Update / Add docs
- **Tests**: Add tests / Improve coverage
- **Config**: Update config / Setup

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
**Title**: `Add user authentication with JWT`

**Description**:
```text
Implement secure user authentication using JWT tokens

- Add login/logout endpoints
- Implement token validation middleware
- Add user registration flow
- Update API documentation
```

### Bug Fix
**Title**: `Fix login validation error`

**Description**:
```text
Resolve email validation issue in user login

- Fix regex pattern for email validation
- Add proper error handling for invalid formats
- Update unit tests for edge cases
```

### Refactor
**Title**: `Refactor API response handling`

**Description**:
```text
Improve API response consistency and error handling

- Standardize response format across endpoints
- Add centralized error handling middleware
- Reduce code duplication in controllers
- Update test assertions
```

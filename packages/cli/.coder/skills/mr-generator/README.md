# MR Generator Skill

Automatically generate concise English MR titles and descriptions based on diff between current branch and remote master.

## Quick Start

```bash
# Make it globally available
ln -sf "$(pwd)/.coder/skills/mr-generator/mr-generate.sh" /usr/local/bin/mr-generate

# Basic usage
mr-generate

# With options
mr-generate --target origin/develop
mr-generate --preview
```

## Integration Examples

### GitHub CLI
```bash
# Create MR with auto-generated title/description
git push origin HEAD
mr-generate | gh pr create --title "$(head -1)" --body "$(tail -n +3)"
```

### GitLab CLI
```bash
# GitLab MR creation
git push origin HEAD
mr-generate | glab mr create --title "$(head -1)" --description "$(tail -n +3)"
```

### Manual Copy
```bash
# Preview before creating MR
mr-generate --preview
# Then copy title/description manually
```

## How It Works

1. **Diff Analysis**: Compares current branch with target (default: origin/master)
2. **Change Classification**: Analyzes file types and patterns
3. **Module Detection**: Identifies main functional areas
4. **Smart Generation**: Creates context-appropriate titles and descriptions

## Output Examples

### Feature Development
```
Add user authentication with JWT

Implement secure user authentication using JWT tokens

- Add login/logout endpoints
- Implement token validation middleware
- Add user registration flow
```

### Bug Fix
```
Fix email validation in login form

Resolve email format validation issue causing login failures

- Update email regex pattern
- Add proper error handling
- Add validation tests
```

### Refactoring
```
Refactor API response handling

Improve API response consistency and error handling

- Standardize response format
- Add centralized error handling
- Reduce code duplication
```

## Configuration

### Environment Variables
```bash
export MR_TARGET_BRANCH=origin/main    # Default target branch
export MR_MAX_TITLE_LENGTH=50          # Title length limit
```

### Git Aliases
```bash
git config alias.mr-title "!.coder/skills/mr-generator/mr-generate.sh"
git config alias.mr-preview "!.coder/skills/mr-generator/mr-generate.sh --preview"
```
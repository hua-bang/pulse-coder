---
name: code-review
description: "Reviews code diffs for security vulnerabilities, performance issues, and maintainability problems. Produces categorized findings with severity levels and fix suggestions. Use when the user asks to review code, check a PR, audit a diff, or get feedback on changes."
---

# Code Review Skill

Analyze code changes and produce actionable review feedback organized by severity.

## Workflow

1. **Identify scope**: determine which files and diffs to review (staged changes, PR diff, or specified files).
2. **Run static checks**: grep for known anti-patterns before reading logic.
   ```bash
   # Security quick-scan
   grep -rn "eval(\|exec(\|innerHTML\|dangerouslySetInnerHTML\|\.query(.*\+\|password.*=.*['\"]" <files>
   # Performance quick-scan
   grep -rn "SELECT \*\|\.forEach.*await\|new Array(" <files>
   ```
3. **Read and analyze**: review each file for logic errors, missing edge cases, naming clarity, and framework misuse.
4. **Categorize findings** using the output format below.
5. **Verify fixes**: if changes are applied, re-run the static checks and confirm issues are resolved.

## Output Format

```markdown
### Critical (must fix before merge)
- **[file:line]** Issue description → suggested fix

### Improvements (should fix)
- **[file:line]** Issue description → suggested fix

### Suggestions (nice to have)
- **[file:line]** Issue description → suggested fix

### Positive Notes
- Highlight well-written code or good patterns worth preserving
```

## Example

Given this diff:
```typescript
app.get('/user', (req, res) => {
  const query = `SELECT * FROM users WHERE id = ${req.params.id}`;
  db.query(query).then(user => res.send(user));
});
```

Review output:
```markdown
### Critical
- **routes/user.ts:2** SQL injection via string interpolation → use parameterized query: `db.query('SELECT id, name FROM users WHERE id = $1', [req.params.id])`
- **routes/user.ts:2** `SELECT *` exposes all columns including sensitive fields → select only needed columns

### Improvements
- **routes/user.ts:3** Missing error handler on promise → add `.catch()` or use try/catch with async/await
```

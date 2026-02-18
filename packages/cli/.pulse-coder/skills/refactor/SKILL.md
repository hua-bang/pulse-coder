---
name: refactor
description: Refactor code to improve structure, readability, and maintainability without changing behavior
version: 1.0.0
author: Pulse Coder Team
---

# Code Refactoring Skill

This skill guides systematic code refactoring while preserving functionality.

## Refactoring Principles

### Extract Method/Function
- Break down large functions into smaller, focused ones
- Name functions based on their purpose
- Each function should do one thing well

### Simplify Conditionals
- Replace complex conditions with well-named functions
- Use early returns to reduce nesting
- Consider guard clauses

### Remove Duplication
- Identify repeated code patterns
- Extract common logic into reusable functions
- Use abstraction wisely (avoid premature optimization)

### Improve Naming
- Use descriptive, meaningful names
- Follow language conventions
- Avoid abbreviations unless widely known

### Organize Code
- Group related functionality
- Separate concerns
- Follow single responsibility principle

## Refactoring Workflow

1. **Understand First**: Read and understand the existing code
2. **Ensure Tests**: Make sure tests exist or write them
3. **Small Steps**: Make incremental changes
4. **Test After Each Step**: Verify functionality is preserved
5. **Review**: Check if the code is clearer than before

## Common Refactoring Patterns

- Extract Method
- Extract Variable
- Inline Method/Variable
- Replace Magic Number with Named Constant
- Replace Conditional with Polymorphism
- Move Method/Field
- Rename Method/Variable

## Safety Guidelines

- Never change behavior while refactoring
- Keep refactoring separate from feature work
- Run tests after each change
- Use version control to track changes
- Consider reverting if complexity increases

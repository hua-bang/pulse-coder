---
name: refactor
description: "Restructures code to reduce complexity, extract reusable functions, simplify conditionals, and eliminate duplication while preserving behavior. Use when the user asks to refactor, clean up, simplify, or reduce technical debt in existing code."
---

# Code Refactoring Skill

Systematically improve code structure without changing behavior.

## Workflow

1. **Scope**: identify the target code and confirm expected behavior with existing tests.
2. **Verify test coverage**: run the project's test suite. If no tests cover the target code, write characterization tests first.
   ```bash
   # Example: run tests covering the target module
   pnpm vitest run --reporter=verbose <test-file>
   ```
3. **Apply refactoring**: make one transformation at a time, choosing from the patterns below.
4. **Re-run tests** after each transformation to confirm behavior is preserved.
5. **Review**: verify the result is simpler than the original. If complexity increased, revert.

## Patterns with Examples

### Extract function
Before:
```typescript
function processOrder(order: Order) {
  // 20 lines of validation logic
  if (!order.items.length) throw new Error('Empty order');
  if (order.items.some(i => i.quantity <= 0)) throw new Error('Invalid quantity');
  if (!order.customer.email) throw new Error('Missing email');
  // ... continue processing
}
```
After:
```typescript
function validateOrder(order: Order) {
  if (!order.items.length) throw new Error('Empty order');
  if (order.items.some(i => i.quantity <= 0)) throw new Error('Invalid quantity');
  if (!order.customer.email) throw new Error('Missing email');
}

function processOrder(order: Order) {
  validateOrder(order);
  // ... continue processing
}
```

### Simplify conditionals with guard clauses
Before:
```typescript
function getDiscount(user: User) {
  if (user.isActive) {
    if (user.orders > 10) {
      if (user.isPremium) {
        return 0.3;
      }
      return 0.2;
    }
    return 0.1;
  }
  return 0;
}
```
After:
```typescript
function getDiscount(user: User) {
  if (!user.isActive) return 0;
  if (user.orders <= 10) return 0.1;
  if (!user.isPremium) return 0.2;
  return 0.3;
}
```

### Replace magic values
Before: `if (retries > 3) { setTimeout(fn, 5000); }`
After:
```typescript
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
if (retries > MAX_RETRIES) { setTimeout(fn, RETRY_DELAY_MS); }
```

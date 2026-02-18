import { Engine } from 'pulse-coder-engine';

/**
 * Single Engine instance shared across all platform adapters.
 * engine.run(context, options) is stateless per-call — each invocation
 * receives its own Context object, so concurrent runs from different users are safe.
 */
export const engine = new Engine();

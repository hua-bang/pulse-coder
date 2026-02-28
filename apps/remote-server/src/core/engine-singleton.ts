import { Engine } from 'pulse-coder-engine';
import { memoryIntegration } from './memory-integration.js';
import { worktreeIntegration } from './worktree/integration.js';

/**
 * Single Engine instance shared across all platform adapters.
 * engine.run(context, options) is stateless per-call - each invocation
 * receives its own Context object, so concurrent runs from different users are safe.
 */
export const engine = new Engine({
  enginePlugins: {
    plugins: [
      memoryIntegration.enginePlugin,
      worktreeIntegration.enginePlugin,
    ],
  },
});

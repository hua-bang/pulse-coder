import { Engine } from 'pulse-coder-engine';
import { memoryEnginePlugin } from './memory-engine-plugin.js';

/**
 * Single Engine instance shared across all platform adapters.
 * engine.run(context, options) is stateless per-call — each invocation
 * receives its own Context object, so concurrent runs from different users are safe.
 */
export const engine = new Engine({
  enginePlugins: {
    plugins: [memoryEnginePlugin],
  },
});

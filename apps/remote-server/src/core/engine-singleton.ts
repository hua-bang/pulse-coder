import { Engine, builtInPtcPlugin } from 'pulse-coder-engine';
import { memoryIntegration } from './memory-integration.js';
import { worktreeIntegration } from './worktree/integration.js';
import { cronJobTool } from './tools/cron-job.js';
import { deferDemoTool } from './tools/defer-demo.js';
import { jinaAiReadTool } from './tools/jina-ai.js';
import { sessionSummaryTool } from './tools/session-summary.js';

/**
 * Single Engine instance shared across all platform adapters.
 * engine.run(context, options) is stateless per-call - each invocation
 * receives its own Context object, so concurrent runs from different users are safe.
 */
export const engine = new Engine({
  enginePlugins: {
    plugins: [
      builtInPtcPlugin,
      memoryIntegration.enginePlugin,
      worktreeIntegration.enginePlugin,
    ],
  },
  tools: {
    cron_job: cronJobTool,
    deferred_demo: deferDemoTool,
    jina_ai_read: jinaAiReadTool,
    session_summary: sessionSummaryTool,
  },
});

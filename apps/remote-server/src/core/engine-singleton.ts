import { Engine } from 'pulse-coder-engine';
import { memoryIntegration } from './memory-integration.js';
import { worktreeIntegration } from './worktree/integration.js';
import { vaultIntegration } from './vault/integration.js';
import { analyzeImageTool } from './tools/analyze-image.js';
import { cronJobTool } from './tools/cron-job.js';
import { deferDemoTool } from './tools/defer-demo.js';
import { jinaAiReadTool } from './tools/jina-ai.js';
import { readLinkedSessionTool } from './tools/read-linked-session.js';
import { sessionSummaryTool } from './tools/session-summary.js';
import { twitterListTweetsTool } from './tools/twitter-list-tweets.js';
import { ptcDemoTools } from './tools/ptc-demo.js';
import { larkCliTool } from './tools/lark-cli.js';
import { devtoolsPlugin } from './devtools.js';
import { langfusePlugin } from './langfuse.js';

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
      vaultIntegration.enginePlugin,
      devtoolsPlugin,
      langfusePlugin,
    ],
  },
  tools: {
    analyze_image: analyzeImageTool,
    cron_job: cronJobTool,
    deferred_demo: deferDemoTool,
    jina_ai_read: jinaAiReadTool,
    read_linked_session: readLinkedSessionTool,
    session_summary: sessionSummaryTool,
    twitter_list_tweets: twitterListTweetsTool,
    lark_cli: larkCliTool,
    ...ptcDemoTools,
  },
});

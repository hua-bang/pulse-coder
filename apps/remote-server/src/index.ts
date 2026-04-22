import dotenv from 'dotenv';
dotenv.config({ override: true });
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { engine } from './core/engine-singleton.js';
import { sessionStore } from './core/session-store.js';
import { memoryIntegration } from './core/memory-integration.js';
import { worktreeIntegration } from './core/worktree/integration.js';
import { vaultIntegration } from './core/vault/integration.js';
import { devtoolsStore } from './core/devtools.js';
import { startDiscordGateway } from './adapters/discord/gateway-manager.js';
import { registerDiscordApplicationCommands } from './adapters/discord/application-commands.js';

async function main() {
  // Initialize session store (creates directories if needed, loads index)
  await sessionStore.initialize();

  // Initialize memory store
  await memoryIntegration.initialize();

  // Initialize worktree binding state store
  await worktreeIntegration.initialize();

  // Initialize vault binding state store
  await vaultIntegration.initialize();

  await devtoolsStore.initialize();

  await engine.initialize();

  startDiscordGateway();

  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = (process.env.HOST ?? '0.0.0.0').trim() || '0.0.0.0';

  console.log(`[remote-server] Starting on ${host}:${port}`);
  serve({
    fetch: app.fetch,
    port,
    hostname: host,
    overrideGlobalObjects: false,
  });
  console.log(`[remote-server] Listening on http://${host}:${port}`);
  console.log(`[remote-server] Endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/devtools/runs`);
  console.log(`  GET  /api/devtools/runs/:runId`);
  console.log(`  GET  /api/devtools/runs/:runId/llm/:spanIndex`);
  console.log(`  GET  /api/devtools/stats/tokens`);
  console.log(`  GET  /api/devtools/stats/sessions`);
  console.log(`  GET  /api/devtools/stats/tools`);
  console.log(`  GET  /api/devtools/errors`);
  // console.log(`  POST /api/chat`);
  // console.log(`  GET  /api/stream/:streamId`);
  // console.log(`  POST /api/clarify/:streamId`);
  console.log(`  POST /webhooks/feishu`);
  console.log(`  POST /webhooks/discord`);
  console.log(`  GET  /internal/discord/gateway/status`);
  console.log(`  POST /internal/discord/gateway/restart`);
  console.log(`  POST /internal/agent/run`);
  // console.log(`  POST /webhooks/telegram`);

  void registerDiscordApplicationCommands().catch((err) => {
    console.error('[discord] Failed to register application commands:', err);
  });
}

main().catch((err) => {
  console.error('[remote-server] Fatal error:', err);
  process.exit(1);
});

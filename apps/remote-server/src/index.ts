import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { engine } from './core/engine-singleton.js';
import { sessionStore } from './core/session-store.js';

async function main() {
  // Initialize session store (creates directories if needed, loads index)
  await sessionStore.initialize();

  // Initialize the AI engine and all its plugins
  await engine.initialize();

  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);

  console.log(`[remote-server] Starting on port ${port}`);
  serve({ fetch: app.fetch, port });
  console.log(`[remote-server] Listening on http://localhost:${port}`);
  console.log(`[remote-server] Endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  POST /api/chat`);
  console.log(`  GET  /api/stream/:streamId`);
  console.log(`  POST /api/clarify/:streamId`);
  console.log(`  POST /webhooks/feishu`);
  console.log(`  POST /webhooks/telegram`);
}

main().catch((err) => {
  console.error('[remote-server] Fatal error:', err);
  process.exit(1);
});

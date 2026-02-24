import { Hono } from 'hono';
import { cors } from 'hono/cors';
// import { apiRouter } from './routes/api.js';
// import { telegramRouter } from './routes/telegram.js';
import { feishuRouter } from './routes/feishu.js';
import { discordRouter } from './routes/discord.js';
import { internalRouter } from './routes/internal.js';

export function createApp(): Hono {
  const app = new Hono();

  // CORS for web clients
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim());
  app.use('/api/*', cors({ origin: origins, allowMethods: ['GET', 'POST', 'DELETE'] }));

  // Health check
  app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

  // Platform webhook routes
  app.route('/webhooks/feishu', feishuRouter);
  app.route('/webhooks/discord', discordRouter);
  // app.route('/webhooks/telegram', telegramRouter);

  // Internal automation routes
  app.route('/internal', internalRouter);

  // Web REST + SSE routes
  // app.route('/api', apiRouter);

  // 404 fallback
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}

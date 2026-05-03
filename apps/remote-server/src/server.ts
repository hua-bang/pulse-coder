import { Hono } from 'hono';
import { cors } from 'hono/cors';
// import { apiRouter } from './routes/api.js';
// import { telegramRouter } from './routes/telegram.js';
import { feishuRouter } from './routes/feishu.js';
import { discordRouter } from './routes/discord.js';
import { internalRouter } from './routes/internal.js';
import { devtoolsRouter } from './routes/devtools.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';

// Point to devtools-web dist — server cwd is apps/remote-server so ../devtools-web resolves correctly.
// Fallback env var allows overriding when running from a different directory.
const devtoolsDistPath = process.env.DEVTOOLS_DIST_PATH ?? resolve(process.cwd(), '../devtools-web/dist');

export function createApp(): Hono {
  const app = new Hono();

  // CORS for web clients
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim());
  app.use('/api/devtools/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'DELETE'] }));
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
  app.route('/api/devtools', devtoolsRouter);
  // app.route('/api', apiRouter);

  // Devtools web UI — serve built static assets at /devtools/*
  app.get('/devtools', (c) => c.redirect('/devtools/'));
  app.use('/devtools/*', serveStatic({
    root: devtoolsDistPath,
    rewriteRequestPath: (path) => path.replace(/^\/devtools/, '') || '/',
  }));

  // 404 fallback
  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}

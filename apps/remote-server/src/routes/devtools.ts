import { Hono } from 'hono';
import { devtoolsStore } from '../core/devtools.js';

export const devtoolsRouter = new Hono();

devtoolsRouter.get('/runs', (c) => {
  const status = c.req.query('status') as 'running' | 'finished' | undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;
  const runs = devtoolsStore.listRuns({ status, limit });
  return c.json({ ok: true, runs });
});

devtoolsRouter.get('/runs/active', (c) => {
  const runs = devtoolsStore.listRuns({ status: 'running', limit: 200 });
  return c.json({ ok: true, runs });
});

devtoolsRouter.get('/runs/:runId', async (c) => {
  const runId = c.req.param('runId');
  const run = await devtoolsStore.getRun(runId);
  if (!run) {
    return c.json({ ok: false, error: 'Not found' }, 404);
  }
  return c.json({ ok: true, run });
});

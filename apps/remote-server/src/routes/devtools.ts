import { Hono } from 'hono';
import { devtoolsStore } from '../core/devtools.js';
import type { TokenStatsGranularity } from 'pulse-coder-plugin-kit/devtools';

export const devtoolsRouter = new Hono();

devtoolsRouter.get('/runs', (c) => {
  const status = c.req.query('status') as 'running' | 'finished' | undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const sessionId = c.req.query('sessionId') || undefined;
  const from = fromRaw ? Number(fromRaw) : undefined;
  const to = toRaw ? Number(toRaw) : undefined;
  const runs = devtoolsStore.listRuns({ status, limit, from, to, sessionId });
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

// ── Token Stats ──────────────────────────────────────────────────────────────

function resolveTimeRange(range: string | undefined, fromRaw: string | undefined, toRaw: string | undefined): { from: number; to: number } {
  const now = Date.now();
  if (range === 'today') {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { from: start, to: now };
  }
  if (range === 'week') {
    return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
  }
  if (range === 'month') {
    return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
  }
  if (range === 'custom' || (!range && fromRaw)) {
    const from = fromRaw ? Number(fromRaw) : now - 7 * 24 * 60 * 60 * 1000;
    const to = toRaw ? Number(toRaw) : now;
    return { from, to };
  }
  // default: last 7 days
  return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
}

devtoolsRouter.get('/stats/tokens', (c) => {
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const granularityRaw = c.req.query('granularity') as TokenStatsGranularity | undefined;
  const sessionId = c.req.query('sessionId') || undefined;

  const granularity: TokenStatsGranularity =
    granularityRaw === 'hour' || granularityRaw === 'week' ? granularityRaw : 'day';

  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);

  const result = devtoolsStore.getTokenStats({ from, to, granularity, sessionId });
  return c.json({ ok: true, from, to, granularity, ...result });
});

// Per-session token breakdown within a time range
devtoolsRouter.get('/stats/sessions', (c) => {
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw))) : 20;

  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);

  // Get all runs in range (no session filter) with a large limit from index
  const runs = devtoolsStore.listRuns({ from, to, limit: 500 });

  // Group by sessionId
  const sessionMap = new Map<string, {
    sessionId: string;
    runCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    lastRunAt: number;
  }>();

  for (const run of runs) {
    const key = run.sessionId ?? 'unknown';
    let entry = sessionMap.get(key);
    if (!entry) {
      entry = {
        sessionId: key,
        runCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        lastRunAt: 0,
      };
      sessionMap.set(key, entry);
    }
    entry.runCount += 1;
    entry.inputTokens += run.totalInputTokens ?? 0;
    entry.outputTokens += run.totalOutputTokens ?? 0;
    entry.cacheReadTokens += run.totalCacheReadTokens ?? 0;
    entry.cacheWriteTokens += run.totalCacheWriteTokens ?? 0;
    entry.totalTokens += (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    if (run.lastEventAt > entry.lastRunAt) {
      entry.lastRunAt = run.lastEventAt;
    }
  }

  const sessions = [...sessionMap.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit);

  return c.json({ ok: true, from, to, sessions });
});

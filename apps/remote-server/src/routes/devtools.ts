import { Hono } from 'hono';
import { devtoolsStore } from '../core/devtools.js';
import type { TokenStatsGranularity, TokenStatsGroupBy } from 'pulse-coder-plugin-kit/devtools';

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

devtoolsRouter.get('/runs/:runId/llm/:spanIndex', async (c) => {
  const runId = c.req.param('runId');
  const spanIndex = Number(c.req.param('spanIndex'));
  if (!Number.isFinite(spanIndex) || spanIndex < 1) {
    return c.json({ ok: false, error: 'Invalid spanIndex' }, 400);
  }
  const snapshot = await devtoolsStore.getLlmPromptSnapshot(runId, spanIndex);
  if (!snapshot) {
    return c.json({ ok: false, error: 'Snapshot not found' }, 404);
  }
  return c.json({ ok: true, snapshot });
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
  const groupByRaw = c.req.query('groupBy') as TokenStatsGroupBy | undefined;

  const granularity: TokenStatsGranularity =
    granularityRaw === 'hour' || granularityRaw === 'week' ? granularityRaw : 'day';
  const groupBy: TokenStatsGroupBy =
    groupByRaw === 'model' || groupByRaw === 'session' ? groupByRaw : 'none';

  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);

  const result = devtoolsStore.getTokenStats({ from, to, granularity, sessionId, groupBy });
  return c.json({ ok: true, from, to, granularity, groupBy, ...result });
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

// ── Sessions (cross-run view) ────────────────────────────────────────────────

devtoolsRouter.get('/sessions', async (c) => {
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;
  const search = (c.req.query('q') || '').trim().toLowerCase();
  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);

  const runs = devtoolsStore.listRuns({ from, to, limit: 500 });
  const map = new Map<string, {
    sessionId: string;
    runCount: number;
    llmCallCount: number;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    errorCount: number;
    costUsd: number;
    firstRunAt: number;
    lastRunAt: number;
    models: Set<string>;
    pluginNames: Set<string>;
  }>();

  for (const run of runs) {
    const key = run.sessionId ?? 'unknown';
    let entry = map.get(key);
    if (!entry) {
      entry = {
        sessionId: key,
        runCount: 0,
        llmCallCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        errorCount: 0,
        costUsd: 0,
        firstRunAt: run.startedAt,
        lastRunAt: run.lastEventAt,
        models: new Set(),
        pluginNames: new Set(),
      };
      map.set(key, entry);
    }
    entry.runCount += 1;
    entry.llmCallCount += run.llmCalls ?? 0;
    entry.toolCallCount += run.toolCalls ?? 0;
    entry.inputTokens += run.totalInputTokens ?? 0;
    entry.outputTokens += run.totalOutputTokens ?? 0;
    entry.cacheReadTokens += run.totalCacheReadTokens ?? 0;
    entry.cacheWriteTokens += run.totalCacheWriteTokens ?? 0;
    entry.totalTokens += (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    entry.errorCount += run.errorCount ?? 0;
    entry.costUsd += run.costUsd ?? 0;
    if (run.startedAt < entry.firstRunAt) entry.firstRunAt = run.startedAt;
    if (run.lastEventAt > entry.lastRunAt) entry.lastRunAt = run.lastEventAt;
    for (const m of run.models ?? []) entry.models.add(m);
    if (run.pluginName) entry.pluginNames.add(run.pluginName);
  }

  let sessions = [...map.values()].map((s) => {
    const cacheDenom = s.inputTokens + s.cacheReadTokens;
    const cacheHitRate = cacheDenom > 0 ? s.cacheReadTokens / cacheDenom : 0;
    return {
      sessionId: s.sessionId,
      runCount: s.runCount,
      llmCallCount: s.llmCallCount,
      toolCallCount: s.toolCallCount,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      totalTokens: s.totalTokens,
      cacheHitRate,
      errorCount: s.errorCount,
      costUsd: s.costUsd > 0 ? Number(s.costUsd.toFixed(6)) : 0,
      firstRunAt: s.firstRunAt,
      lastRunAt: s.lastRunAt,
      models: [...s.models],
      pluginNames: [...s.pluginNames],
    };
  });

  if (search) {
    sessions = sessions.filter((s) => s.sessionId.toLowerCase().includes(search));
  }

  sessions.sort((a, b) => b.lastRunAt - a.lastRunAt);
  sessions = sessions.slice(0, limit);

  return c.json({ ok: true, from, to, sessions });
});

devtoolsRouter.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const { from, to } = resolveTimeRange(range || 'month', fromRaw, toRaw);

  const summaries = devtoolsStore.listRuns({ sessionId, from, to, limit: 200 });
  if (summaries.length === 0) {
    return c.json({ ok: false, error: 'No runs for session in range' }, 404);
  }

  // Load full records to get llmSpans (needed for cross-run cache diff timeline)
  const fullRuns = await Promise.all(
    summaries.map((s) => devtoolsStore.getRun(s.runId)),
  );

  const runs: Array<{
    runId: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    pluginName?: string;
    caller?: string;
    userTextPreview?: string;
    llmCalls: number;
    toolCalls: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCacheReadTokens?: number;
    errorCount?: number;
    costUsd?: number;
    models?: string[];
  }> = [];

  const llmCalls: Array<{
    runId: string;
    runStartedAt: number;
    pluginName?: string;
    spanIndex: number;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    messageCount?: number;
    finishReason?: string;
    errorMessage?: string;
    promptRef?: string;
    systemPromptPreview?: string;
  }> = [];

  let agg = {
    runCount: summaries.length,
    llmCallCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errorCount: 0,
    costUsd: 0,
    firstRunAt: Number.POSITIVE_INFINITY,
    lastRunAt: 0,
    models: new Set<string>(),
  };

  for (let i = 0; i < summaries.length; i += 1) {
    const sum = summaries[i];
    const full = fullRuns[i];
    runs.push({
      runId: sum.runId,
      status: sum.status,
      startedAt: sum.startedAt,
      endedAt: full?.endedAt,
      durationMs: sum.durationMs,
      pluginName: sum.pluginName,
      caller: sum.caller,
      userTextPreview: sum.userTextPreview,
      llmCalls: sum.llmCalls,
      toolCalls: sum.toolCalls,
      totalInputTokens: sum.totalInputTokens,
      totalOutputTokens: sum.totalOutputTokens,
      totalCacheReadTokens: sum.totalCacheReadTokens,
      errorCount: sum.errorCount,
      costUsd: sum.costUsd,
      models: sum.models,
    });

    agg.llmCallCount += sum.llmCalls ?? 0;
    agg.toolCallCount += sum.toolCalls ?? 0;
    agg.inputTokens += sum.totalInputTokens ?? 0;
    agg.outputTokens += sum.totalOutputTokens ?? 0;
    agg.cacheReadTokens += sum.totalCacheReadTokens ?? 0;
    agg.cacheWriteTokens += sum.totalCacheWriteTokens ?? 0;
    agg.errorCount += sum.errorCount ?? 0;
    agg.costUsd += sum.costUsd ?? 0;
    if (sum.startedAt < agg.firstRunAt) agg.firstRunAt = sum.startedAt;
    if (sum.lastEventAt > agg.lastRunAt) agg.lastRunAt = sum.lastEventAt;
    for (const m of sum.models ?? []) agg.models.add(m);

    if (full?.llmSpans) {
      for (const span of full.llmSpans) {
        llmCalls.push({
          runId: sum.runId,
          runStartedAt: sum.startedAt,
          pluginName: sum.pluginName,
          spanIndex: span.index,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          durationMs: span.durationMs,
          model: span.model,
          inputTokens: span.inputTokens,
          outputTokens: span.outputTokens,
          cacheReadTokens: span.cacheReadTokens,
          cacheWriteTokens: span.cacheWriteTokens,
          messageCount: span.messageCount,
          finishReason: span.finishReason,
          errorMessage: span.errorMessage,
          promptRef: span.promptRef,
          systemPromptPreview: span.systemPromptPreview,
        });
      }
    }
  }

  llmCalls.sort((a, b) => a.startedAt - b.startedAt);
  runs.sort((a, b) => a.startedAt - b.startedAt);

  const cacheDenom = agg.inputTokens + agg.cacheReadTokens;
  const aggregate = {
    sessionId,
    runCount: agg.runCount,
    llmCallCount: agg.llmCallCount,
    toolCallCount: agg.toolCallCount,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    totalTokens: agg.inputTokens + agg.outputTokens,
    cacheHitRate: cacheDenom > 0 ? agg.cacheReadTokens / cacheDenom : 0,
    errorCount: agg.errorCount,
    costUsd: agg.costUsd > 0 ? Number(agg.costUsd.toFixed(6)) : 0,
    firstRunAt: Number.isFinite(agg.firstRunAt) ? agg.firstRunAt : 0,
    lastRunAt: agg.lastRunAt,
    models: [...agg.models],
  };

  return c.json({ ok: true, sessionId, aggregate, runs, llmCalls });
});

// ── Tool Health Stats ────────────────────────────────────────────────────────

devtoolsRouter.get('/stats/tools', async (c) => {
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const sessionId = c.req.query('sessionId') || undefined;
  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);
  const result = await devtoolsStore.getToolStats({ from, to, sessionId });
  return c.json({ ok: true, ...result });
});

// ── Errors ───────────────────────────────────────────────────────────────────

devtoolsRouter.get('/errors', async (c) => {
  const range = c.req.query('range');
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const sessionId = c.req.query('sessionId') || undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 200;
  const { from, to } = resolveTimeRange(range, fromRaw, toRaw);
  const result = await devtoolsStore.getErrors({ from, to, sessionId, limit });
  return c.json({ ok: true, ...result });
});

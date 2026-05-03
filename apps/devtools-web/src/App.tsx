import { useEffect, useMemo, useState } from 'react';

type RunStatus = 'running' | 'finished';
type PageView = 'runs' | 'stats' | 'tools' | 'errors';
type StatsRange = 'today' | 'week' | 'month' | 'custom';
type StatsGranularity = 'hour' | 'day' | 'week';
type StatsGroupBy = 'none' | 'model' | 'session';

interface RunSummary {
  runId: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  lastEventAt: number;
  durationMs?: number;
  pluginName?: string;
  pluginVersion?: string;
  sessionId?: string;
  platformKey?: string;
  caller?: string;
  userTextPreview?: string;
  llmCalls: number;
  toolCalls: number;
  compactions: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  models?: string[];
  errorCount?: number;
  costUsd?: number;
}

interface TokenStatsBucket {
  ts: number;
  label: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

interface TokenStatsSummary {
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

interface TokenStatsGroupEntry {
  key: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

interface TokenStatsResponse {
  ok: boolean;
  from: number;
  to: number;
  granularity: StatsGranularity;
  groupBy?: StatsGroupBy;
  summary: TokenStatsSummary;
  buckets: TokenStatsBucket[];
  groups?: TokenStatsGroupEntry[];
}

interface SessionBreakdown {
  sessionId: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  lastRunAt: number;
}

interface SessionStatsResponse {
  ok: boolean;
  from: number;
  to: number;
  sessions: SessionBreakdown[];
}

interface LlmSpan {
  index: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  requestStartAt?: number;
  firstChunkAt?: number;
  firstTextAt?: number;
  enginePrepMs?: number;
  ttfbMs?: number;
  ttftMs?: number;
  ttftTextMs?: number;
  streamDurationMs?: number;
  finishReason?: string;
  textLength?: number;
  model?: string;
  toolCalls?: Array<{
    name: string;
    inputSize?: number;
    inputPreview?: string;
  }>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageRaw?: string;
  usageTruncated?: boolean;
  promptRef?: string;
  systemPromptPreview?: string;
  messageCount?: number;
  toolNames?: string[];
  messagesBytes?: number;
  promptTruncated?: boolean;
  errorMessage?: string;
}

interface LlmPromptSnapshot {
  runId: string;
  spanIndex: number;
  capturedAt: number;
  model?: string;
  systemPrompt?: string;
  systemPromptTruncated?: boolean;
  messages: any[];
  messagesTruncated?: boolean;
  toolNames?: string[];
  totalBytes?: number;
}

interface ToolStatEntry {
  name: string;
  count: number;
  errorCount: number;
  errorRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  avgInputBytes: number;
  avgOutputBytes: number;
  lastUsedAt: number;
}

interface ToolStatsResponse {
  ok: boolean;
  from: number;
  to: number;
  totalCalls: number;
  tools: ToolStatEntry[];
}

interface DevtoolsErrorEntry {
  runId: string;
  source: 'tool' | 'llm';
  name: string;
  message: string;
  at: number;
  spanIndex?: number;
  sessionId?: string;
}

interface ErrorAggregateEntry {
  message: string;
  count: number;
  source: 'tool' | 'llm';
  names: string[];
  lastAt: number;
  sampleRunIds: string[];
}

interface ErrorsResponse {
  ok: boolean;
  from: number;
  to: number;
  total: number;
  entries: DevtoolsErrorEntry[];
  aggregates: ErrorAggregateEntry[];
}

interface ToolSpan {
  index: number;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  inputSize?: number;
  outputSize?: number;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}

interface CompactionEvent {
  at: number;
  attempt: number;
  trigger: 'pre-loop' | 'length-retry';
  reason?: string;
  forced: boolean;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  strategy: 'summary' | 'summary-too-large' | 'fallback';
}

interface RunDetail extends RunSummary {
  endedAt?: number;
  userText?: string;
  callerSelectors?: string[];
  llmSpans: LlmSpan[];
  toolSpans: ToolSpan[];
  compactionEvents: CompactionEvent[];
  pluginHooks: Array<{
    pluginName: string;
    hookName: string;
    startedAt: number;
    durationMs: number;
  }>;
  resultTextPreview?: string;
}

const DEFAULT_BASE_URL = '/api/devtools';

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleTimeString();
}

function formatDuration(value?: number): string {
  if (value === undefined || value === null) return 'n/a';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function sanitizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.replace(/\/$/, '');
}

function extractCachedTokens(raw?: string): number | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const direct = (parsed as any).cachedInputTokens;
      if (typeof direct === 'number' && Number.isFinite(direct)) {
        return direct;
      }
      const details = (parsed as any).inputTokenDetails;
      if (details && typeof details.cacheReadTokens === 'number') {
        return details.cacheReadTokens;
      }
      const rawDetails = (parsed as any).raw?.input_tokens_details;
      if (rawDetails && typeof rawDetails.cached_tokens === 'number') {
        return rawDetails.cached_tokens;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export default function App() {
  const initialBaseUrl = sanitizeBaseUrl(localStorage.getItem('devtoolsBaseUrl') || DEFAULT_BASE_URL);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlInput, setBaseUrlInput] = useState(initialBaseUrl);
  const [page, setPage] = useState<PageView>('runs');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sessionFilter, setSessionFilter] = useState('');
  const [groupBy, setGroupBy] = useState<'none' | 'session'>('none');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'finished'>('all');
  const [sortBy, setSortBy] = useState<'recent' | 'duration' | 'lastEvent'>('recent');
  const [detailTab, setDetailTab] = useState<'llm' | 'plugins' | 'timeline' | 'prompt'>('llm');
  const [timelineRange, setTimelineRange] = useState({ from: 1, to: 1 });

  const apiBase = useMemo(() => sanitizeBaseUrl(baseUrl), [baseUrl]);

  const fetchJson = async (path: string) => {
    const response = await fetch(`${apiBase}${path}`);
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    return response.json();
  };

  const loadRuns = async () => {
    try {
      setListError(null);
      const data = await fetchJson('/runs?limit=60');
      const list = (data.runs || []) as RunSummary[];
      setRuns(list);
      setSelectedId((current) => {
        if (!list.length) {
          setSelectedRun(null);
          return null;
        }
        if (current && list.some((item) => item.runId === current)) {
          return current;
        }
        return list[0].runId;
      });
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  };

  const loadRunDetail = async (runId: string) => {
    try {
      setDetailError(null);
      const data = await fetchJson(`/runs/${runId}`);
      setSelectedRun(data.run as RunDetail);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
      setSelectedRun(null);
    }
  };

  const applyBaseUrl = (value: string) => {
    const next = sanitizeBaseUrl(value);
    setBaseUrl(next);
    setBaseUrlInput(next);
    localStorage.setItem('devtoolsBaseUrl', next);
  };

  useEffect(() => {
    loadRuns();
  }, [apiBase]);

  useEffect(() => {
    if (selectedId) {
      loadRunDetail(selectedId);
    }
  }, [selectedId, apiBase]);

  useEffect(() => {
    if (!selectedRun?.llmSpans?.length) {
      setTimelineRange({ from: 1, to: 1 });
      return;
    }
    const maxTurn = selectedRun.llmSpans.reduce((max, span) => Math.max(max, span.index), 1);
    setTimelineRange({ from: 1, to: maxTurn });
  }, [selectedRun?.runId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      loadRuns();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, apiBase]);

  const filteredRuns = useMemo(() => {
    let list = runs;
    if (statusFilter !== 'all') {
      list = list.filter((run) => run.status === statusFilter);
    }
    if (sessionFilter.trim()) {
      const needle = sessionFilter.trim().toLowerCase();
      list = list.filter((run) => (run.sessionId ?? '').toLowerCase().includes(needle));
    }
    const now = Date.now();
    const sorted = [...list].sort((a, b) => {
      if (sortBy === 'duration') {
        const aDur = a.durationMs ?? now - a.startedAt;
        const bDur = b.durationMs ?? now - b.startedAt;
        return bDur - aDur;
      }
      if (sortBy === 'lastEvent') {
        return b.lastEventAt - a.lastEventAt;
      }
      return b.startedAt - a.startedAt;
    });
    return sorted;
  }, [runs, sessionFilter, statusFilter, sortBy]);

  useEffect(() => {
    if (!filteredRuns.length) {
      setSelectedId(null);
      setSelectedRun(null);
      return;
    }
    if (selectedId && filteredRuns.some((run) => run.runId === selectedId)) {
      return;
    }
    setSelectedId(filteredRuns[0].runId);
  }, [filteredRuns, selectedId]);

  const groupedRuns = useMemo(() => {
    if (groupBy !== 'session') {
      return null;
    }
    return filteredRuns.reduce<Record<string, RunSummary[]>>((acc, run) => {
      const key = run.sessionId ?? 'unknown';
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(run);
      return acc;
    }, {});
  }, [filteredRuns, groupBy]);

  const renderDetail = () => {
    if (detailError) {
      return <div className="error">{detailError}</div>;
    }
    if (!selectedRun) {
      return <div className="empty">Select a run to inspect.</div>;
    }

    const now = Date.now();
    const isRunning = selectedRun.status === 'running';
    const lastEventAgo = now - selectedRun.lastEventAt;
    const stallThresholdMs = 30000;
    const isStalled = isRunning && lastEventAgo > stallThresholdMs;

    const llmSpans = selectedRun.llmSpans.filter((span) => span.durationMs !== undefined);
    const toolSpans = selectedRun.toolSpans.filter((span) => span.durationMs !== undefined);
    const pluginHooks = selectedRun.pluginHooks ?? [];
    const compactionEvents = selectedRun.compactionEvents ?? [];
    const maxTurn = selectedRun.llmSpans.reduce((max, span) => Math.max(max, span.index), 1);
    const rangeFrom = Math.min(timelineRange.from, maxTurn);
    const rangeTo = Math.max(rangeFrom, Math.min(timelineRange.to, maxTurn));

    const totalLlmTime = llmSpans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
    const totalToolTime = toolSpans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
    const totalHookTime = pluginHooks.reduce((sum, hook) => sum + (hook.durationMs ?? 0), 0);
    const totalCacheRead = selectedRun.llmSpans.reduce((sum, span) => sum + (span.cacheReadTokens ?? 0), 0);
    const totalCacheWrite = selectedRun.llmSpans.reduce((sum, span) => sum + (span.cacheWriteTokens ?? 0), 0);
    const hasCacheRead = selectedRun.llmSpans.some((span) => span.cacheReadTokens !== undefined);
    const hasCacheWrite = selectedRun.llmSpans.some((span) => span.cacheWriteTokens !== undefined);

    const toolTimeForSpan = (span: LlmSpan) => {
      if (!span.startedAt || !span.endedAt) return 0;
      return toolSpans.reduce((sum, tool) => {
        if (!tool.startedAt || !tool.endedAt) return sum;
        const overlaps = tool.startedAt >= span.startedAt && tool.endedAt <= span.endedAt;
        if (!overlaps) return sum;
        return sum + (tool.durationMs ?? Math.max(0, tool.endedAt - tool.startedAt));
      }, 0);
    };

    const formatMetric = (value?: number) => (value !== undefined ? formatDuration(value) : 'n/a');

    const llmWindows = selectedRun.llmSpans.map((span) => ({
      index: span.index,
      start: span.startedAt,
      end: span.endedAt ?? now,
    }));

    const resolveTurn = (timestamp: number) => {
      for (const span of llmWindows) {
        if (timestamp >= span.start && timestamp <= span.end) {
          return span.index;
        }
      }
      const fallback = [...llmWindows].reverse().find((span) => timestamp >= span.start);
      return fallback?.index;
    };

    const hookPriority = (hookName?: string) => {
      if (!hookName) return 35;
      if (hookName.startsWith('beforeRun')) return 0;
      if (hookName.startsWith('onCompacted')) return 5;
      if (hookName.startsWith('beforeLLMCall')) return 10;
      if (hookName.startsWith('onToolCall')) return 25;
      if (hookName.startsWith('beforeToolCall')) return 30;
      if (hookName.startsWith('afterToolCall')) return 50;
      if (hookName.startsWith('afterLLMCall')) return 60;
      if (hookName.startsWith('afterRun')) return 70;
      return 35;
    };

    const eventPriority = (event: { type: string; hookName?: string }) => {
      if (event.type === 'llm') return 20;
      if (event.type === 'tool') return 40;
      if (event.type === 'hook') return hookPriority(event.hookName);
      return 45;
    };

    const slowestLlm = llmSpans.reduce<LlmSpan | null>((acc, span) => {
      if (!acc || (span.durationMs ?? 0) > (acc.durationMs ?? 0)) {
        return span;
      }
      return acc;
    }, null);
    const slowestTool = toolSpans.reduce<ToolSpan | null>((acc, span) => {
      if (!acc || (span.durationMs ?? 0) > (acc.durationMs ?? 0)) {
        return span;
      }
      return acc;
    }, null);
    const slowestHook = pluginHooks.reduce<{ pluginName: string; hookName: string; durationMs: number } | null>(
      (acc, hook) => {
        if (!acc || hook.durationMs > acc.durationMs) {
          return hook;
        }
        return acc;
      },
      null,
    );

    const topLlm = [...llmSpans]
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 5);
    const topTool = [...toolSpans]
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 5);
    const topHooks = [...pluginHooks]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5);
    const maxLlm = topLlm[0]?.durationMs ?? 0;
    const maxTool = topTool[0]?.durationMs ?? 0;
    const maxHook = topHooks[0]?.durationMs ?? 0;

    const runStart = selectedRun.startedAt;
    const runEnd = selectedRun.endedAt ?? now;
    const runDuration = Math.max(1, runEnd - runStart);
    const timelineLlmTool = [
      ...selectedRun.llmSpans.map((span) => {
        const ttft =
          span.ttftMs ??
          (span.firstChunkAt && span.startedAt ? Math.max(0, span.firstChunkAt - span.startedAt) : undefined);
        const enginePrep =
          span.enginePrepMs ??
          (span.requestStartAt && span.startedAt ? Math.max(0, span.requestStartAt - span.startedAt) : undefined);
        const ttfb =
          span.ttfbMs ??
          (span.firstChunkAt
            ? Math.max(0, span.firstChunkAt - (span.requestStartAt ?? span.startedAt))
            : undefined);
        const ttftText =
          span.ttftTextMs ??
          (span.firstTextAt
            ? Math.max(0, span.firstTextAt - (span.requestStartAt ?? span.startedAt))
            : undefined);
        const stream =
          span.streamDurationMs ??
          (span.firstChunkAt && span.endedAt ? Math.max(0, span.endedAt - span.firstChunkAt) : undefined);
        const toolTime = toolTimeForSpan(span);
        const toolWait = span.durationMs !== undefined ? Math.max(0, (span.durationMs ?? 0) - toolTime) : undefined;
        const tooltip = [
          `Engine prep: ${formatMetric(enginePrep)}`,
          `TTFB: ${formatMetric(ttfb)}`,
          `TTFT (text): ${formatMetric(ttftText)}`,
          `TTFT: ${formatMetric(ttft)}`,
          `Stream: ${formatMetric(stream)}`,
          `Tool wait: ${formatMetric(toolWait)}`,
          `Tool exec: ${formatMetric(toolTime)}`,
        ].join('\n');

        return {
          type: 'llm' as const,
          label: `LLM #${span.index}`,
          start: span.startedAt,
          end: span.endedAt ?? now,
          duration: span.durationMs ?? Math.max(0, now - span.startedAt),
          turn: span.index,
          tooltip,
          priority: 20,
        };
      }),
      ...selectedRun.toolSpans.map((span) => ({
        type: 'tool' as const,
        label: span.name,
        start: span.startedAt,
        end: span.endedAt ?? now,
        duration: span.durationMs ?? Math.max(0, now - span.startedAt),
        turn: resolveTurn(span.startedAt),
        priority: 40,
      })),
    ]
      .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end))
      .sort((a, b) => (a.start !== b.start ? a.start - b.start : (a.priority ?? 0) - (b.priority ?? 0)));

    const timelineHooks = pluginHooks
      .map((hook, idx) => ({
        type: 'hook' as const,
        label: `${hook.pluginName}.${hook.hookName} #${idx + 1}`,
        start: hook.startedAt,
        end: hook.startedAt + hook.durationMs,
        duration: hook.durationMs,
        turn: resolveTurn(hook.startedAt),
        hookName: hook.hookName,
        priority: hookPriority(hook.hookName),
      }))
      .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end))
      .sort((a, b) => (a.start !== b.start ? a.start - b.start : (a.priority ?? 0) - (b.priority ?? 0)));

    const timelineAll = [...timelineLlmTool, ...timelineHooks].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return eventPriority(a) - eventPriority(b);
    });
    const filterByTurn = <T extends { turn?: number }>(events: T[]) =>
      events.filter((event) => {
        if (!event.turn || event.turn < 1) {
          return rangeFrom <= 1;
        }
        return event.turn >= rangeFrom && event.turn <= rangeTo;
      });

    const buildTimelineRows = <T extends { turn?: number; type: string; start: number; label: string }>(events: T[]) => {
      const grouped = new Map<number, T[]>();
      for (const event of events) {
        const key = event.turn && event.turn > 0 ? event.turn : 0;
        const bucket = grouped.get(key) ?? [];
        bucket.push(event);
        grouped.set(key, bucket);
      }
      const rows: Array<
        | { type: 'separator'; key: string; label: string }
        | { type: 'event'; key: string; event: T }
      > = [];
      const turnKeys = Array.from(grouped.keys()).sort((a, b) => a - b);
      for (const turnKey of turnKeys) {
        const label = turnKey === 0 ? 'Pre-run' : `Turn T${turnKey}`;
        rows.push({ type: 'separator', key: `sep-${turnKey}`, label });
        const bucket = grouped.get(turnKey) ?? [];
        for (const event of bucket) {
          rows.push({ type: 'event', key: `${event.type}-${event.start}-${event.label}`, event });
        }
      }
      return rows;
    };

    const timelineAllFiltered = filterByTurn(timelineAll);
    const timelineRows = buildTimelineRows(timelineAllFiltered);
    const timelineLlmToolFiltered = filterByTurn(timelineLlmTool);
    const timelineLlmToolRows = buildTimelineRows(timelineLlmToolFiltered);
    const timelineHooksFiltered = filterByTurn(timelineHooks);
    const timelineHookRows = buildTimelineRows(timelineHooksFiltered);

    const gapEvents: Array<{
      start: number;
      end: number;
      duration: number;
      before: string;
      after: string;
    }> = [];
    let lastEnd = runStart;
    let lastLabel = 'Run start';
    for (const event of timelineLlmTool) {
      if (event.start > lastEnd) {
        gapEvents.push({
          start: lastEnd,
          end: event.start,
          duration: event.start - lastEnd,
          before: lastLabel,
          after: event.label,
        });
      }
      if (event.end > lastEnd) {
        lastEnd = event.end;
        lastLabel = event.label;
      }
    }
    if (runEnd > lastEnd) {
      gapEvents.push({
        start: lastEnd,
        end: runEnd,
        duration: runEnd - lastEnd,
        before: lastLabel,
        after: 'Run end',
      });
    }

    const sortedGaps = [...gapEvents].sort((a, b) => b.duration - a.duration);
    const topGaps = sortedGaps.slice(0, 5);
    const totalGapTime = gapEvents.reduce((sum, gap) => sum + gap.duration, 0);
    const largestGap = topGaps[0];

    const gapAllEvents: Array<{
      start: number;
      end: number;
      duration: number;
      before: string;
      after: string;
    }> = [];
    let lastAllEnd = runStart;
    let lastAllLabel = 'Run start';
    for (const event of timelineAll) {
      if (event.start > lastAllEnd) {
        gapAllEvents.push({
          start: lastAllEnd,
          end: event.start,
          duration: event.start - lastAllEnd,
          before: lastAllLabel,
          after: event.label,
        });
      }
      if (event.end > lastAllEnd) {
        lastAllEnd = event.end;
        lastAllLabel = event.label;
      }
    }
    if (runEnd > lastAllEnd) {
      gapAllEvents.push({
        start: lastAllEnd,
        end: runEnd,
        duration: runEnd - lastAllEnd,
        before: lastAllLabel,
        after: 'Run end',
      });
    }
    const topAllGaps = [...gapAllEvents].sort((a, b) => b.duration - a.duration).slice(0, 5);

    return (
      <div className="detail">
        <div className="detail-grid">
          <InfoCard label="Status" value={selectedRun.status} />
          <InfoCard label="Duration" value={formatDuration(selectedRun.durationMs || Date.now() - selectedRun.startedAt)} />
          <InfoCard label="Platform" value={selectedRun.platformKey || 'n/a'} />
          <InfoCard label="Devtools" value={selectedRun.pluginVersion || 'n/a'} />
          <InfoCard label="Session" value={selectedRun.sessionId || 'n/a'} copyValue={selectedRun.sessionId} />
          <InfoCard label="LLM Calls" value={String(selectedRun.llmCalls)} />
          <InfoCard label="Tool Calls" value={String(selectedRun.toolCalls)} />
          <InfoCard label="Compactions" value={String(selectedRun.compactions)} />
          <InfoCard label="Last Event" value={formatTime(selectedRun.lastEventAt)} />
          <InfoCard label="Cache Read" value={hasCacheRead ? String(totalCacheRead) : 'n/a'} />
          <InfoCard label="Cache Write" value={hasCacheWrite ? String(totalCacheWrite) : 'n/a'} />
        </div>

        <div className="pill-row">
          <span className="pill">
            Run ID: {selectedRun.runId}
            <CopyButton value={selectedRun.runId} />
          </span>
          {selectedRun.caller ? <span className="pill">Caller: {selectedRun.caller}</span> : null}
          {isStalled ? (
            <span className="pill pill-warn">Stalled {Math.round(lastEventAgo / 1000)}s</span>
          ) : null}
        </div>

        <div className="detail-tabs">
          <button
            className={`tab-button ${detailTab === 'llm' ? 'active' : ''}`}
            onClick={() => setDetailTab('llm')}
          >
            LLM & Tools
          </button>
          <button
            className={`tab-button ${detailTab === 'prompt' ? 'active' : ''}`}
            onClick={() => setDetailTab('prompt')}
          >
            Prompts
          </button>
          <button
            className={`tab-button ${detailTab === 'timeline' ? 'active' : ''}`}
            onClick={() => setDetailTab('timeline')}
          >
            Timeline
          </button>
          <button
            className={`tab-button ${detailTab === 'plugins' ? 'active' : ''}`}
            onClick={() => setDetailTab('plugins')}
          >
            Engine Plugins
          </button>
        </div>

        {detailTab === 'llm' ? (
          <>
            <section className="section">
              <h2>Bottlenecks</h2>
              <div className="hot-grid">
                <div className="hot-card">
                  <div className="hot-label">Slowest LLM span</div>
                  <div className="hot-value">
                    {slowestLlm ? `#${slowestLlm.index} · ${formatDuration(slowestLlm.durationMs)}` : 'n/a'}
                  </div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Slowest tool call</div>
                  <div className="hot-value">
                    {slowestTool ? `${slowestTool.name} · ${formatDuration(slowestTool.durationMs)}` : 'n/a'}
                  </div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Total LLM time</div>
                  <div className="hot-value">{formatDuration(totalLlmTime)}</div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Total tool time</div>
                  <div className="hot-value">{formatDuration(totalToolTime)}</div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Idle gaps total</div>
                  <div className="hot-value">{formatDuration(totalGapTime)}</div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Largest idle gap</div>
                  <div className="hot-value">
                    {largestGap ? `${formatDuration(largestGap.duration)} · ${formatTime(largestGap.start)}` : 'n/a'}
                  </div>
                </div>
              </div>

              <div className="bar-block">
                <div className="bar-title">Top LLM spans</div>
                {topLlm.length ? (
                  topLlm.map((span) => (
                    <div key={`llm-${span.index}`} className="bar-row">
                      <div className="bar-label">LLM #{span.index}</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.max(6, ((span.durationMs ?? 0) / (maxLlm || 1)) * 100)}%` }}
                        />
                      </div>
                      <div className="bar-value">{formatDuration(span.durationMs)}</div>
                    </div>
                  ))
                ) : (
                  <div className="empty">No LLM spans yet.</div>
                )}
              </div>

              <div className="bar-block">
                <div className="bar-title">Top tool calls</div>
                {topTool.length ? (
                  topTool.map((span) => (
                    <div key={`tool-${span.index}`} className="bar-row">
                      <div className="bar-label">{span.name}</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.max(6, ((span.durationMs ?? 0) / (maxTool || 1)) * 100)}%` }}
                        />
                      </div>
                      <div className="bar-value">{formatDuration(span.durationMs)}</div>
                    </div>
                  ))
                ) : (
                  <div className="empty">No tool calls yet.</div>
                )}
              </div>
            </section>

            {selectedRun.userText ? (
              <section className="section">
                <h2>User Text</h2>
                <div className="mono-block">{selectedRun.userText}</div>
              </section>
            ) : null}

            {selectedRun.resultTextPreview ? (
              <section className="section">
                <h2>Result Preview</h2>
                <div className="mono-block">{selectedRun.resultTextPreview}</div>
              </section>
            ) : null}

            <section className="section">
              <h2>Timeline</h2>
              {maxTurn > 1 ? (
                <div className="timeline-filter">
                  <label>
                    From
                    <select
                      value={rangeFrom}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          from: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`llm-from-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      value={rangeTo}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          to: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`llm-to-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              {timelineLlmToolFiltered.length ? (
                <div className="timeline">
                  {timelineLlmToolRows.map((row) => {
                    if (row.type === 'separator') {
                      return (
                        <div key={row.key} className="timeline-divider">
                          <span>{row.label}</span>
                        </div>
                      );
                    }
                    const event = row.event;
                    const left = ((event.start - runStart) / runDuration) * 100;
                    const width = ((event.end - event.start) / runDuration) * 100;
                    return (
                      <div key={row.key} className={`timeline-row ${event.type}`}>
                        <div className="timeline-label">{event.label}</div>
                        <div className="timeline-track" data-tooltip={event.tooltip}>
                          <div
                            className="timeline-bar"
                            style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(2, width)}%` }}
                          />
                        </div>
                        <div className="timeline-value">{formatDuration(event.duration)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No timeline data yet.</div>
              )}
            </section>

            <section className="section">
              <h2>Stall Analysis</h2>
              {topGaps.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Gap</th>
                        <th>Start</th>
                        <th>Between</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topGaps.map((gap, idx) => (
                        <tr key={`${gap.start}-${idx}`}>
                          <td>{formatDuration(gap.duration)}</td>
                          <td>{formatTime(gap.start)}</td>
                          <td>
                            {gap.before} → {gap.after}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">No idle gaps detected.</div>
              )}
            </section>

            <section className="section">
              <h2>LLM Spans</h2>
              {selectedRun.llmSpans.length ? (
                <div className="table-scroll">
                  <table>
                <thead>
                  <tr>
                    <th>Index</th>
                    <th>Duration</th>
                    <th title="Engine preparation before HTTP request (includes connection establishment)">Eng Prep</th>
                    <th title="Time from HTTP request sent to first chunk received (network + model latency)">TTFB</th>
                    <th title="Time from LLM call start to first chunk (= Eng Prep + TTFB)">TTFT</th>
                    <th title="Time from HTTP request sent to first text token (excludes tool-call-only chunks)">TTFT Text</th>
                    <th title="Time from first chunk to last chunk (stream transfer duration)">Stream</th>
                    <th>Tool Wait</th>
                    <th>Finish</th>
                    <th>Text Len</th>
                    <th>Input Tok</th>
                    <th>Output Tok</th>
                    <th>Cached Tok</th>
                    <th>Cache Write</th>
                    <th>Usage</th>
                    <th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRun.llmSpans.map((span) => {
                    const enginePrep =
                      span.enginePrepMs ??
                      (span.requestStartAt && span.startedAt ? Math.max(0, span.requestStartAt - span.startedAt) : undefined);
                    const ttft =
                      span.ttftMs ??
                      (span.firstChunkAt && span.startedAt ? Math.max(0, span.firstChunkAt - span.startedAt) : undefined);
                    const ttfb =
                      span.ttfbMs ??
                      (span.firstChunkAt
                        ? Math.max(0, span.firstChunkAt - (span.requestStartAt ?? span.startedAt))
                        : undefined);
                    const ttftText =
                      span.ttftTextMs ??
                      (span.firstTextAt
                        ? Math.max(0, span.firstTextAt - (span.requestStartAt ?? span.startedAt))
                        : undefined);
                    const stream =
                      span.streamDurationMs ??
                      (span.firstChunkAt && span.endedAt ? Math.max(0, span.endedAt - span.firstChunkAt) : undefined);
                    const toolTime = toolTimeForSpan(span);
                    const toolWait =
                      span.durationMs !== undefined ? Math.max(0, (span.durationMs ?? 0) - toolTime) : undefined;

                    return (
                    <tr key={span.index}>
                      <td>#{span.index}</td>
                      <td>{formatDuration(span.durationMs)}</td>
                      <td>{enginePrep !== undefined ? formatDuration(enginePrep) : 'n/a'}</td>
                      <td>{ttfb !== undefined ? formatDuration(ttfb) : 'n/a'}</td>
                      <td>{ttft !== undefined ? formatDuration(ttft) : 'n/a'}</td>
                      <td>{ttftText !== undefined ? formatDuration(ttftText) : '—'}</td>
                      <td>{stream !== undefined ? formatDuration(stream) : 'n/a'}</td>
                      <td>{toolWait !== undefined ? formatDuration(toolWait) : 'n/a'}</td>
                      <td>{span.finishReason || 'n/a'}</td>
                      <td>{span.textLength ?? 'n/a'}</td>
                      <td>{span.inputTokens ?? 'n/a'}</td>
                      <td>{span.outputTokens ?? 'n/a'}</td>
                      <td>{span.cacheReadTokens ?? extractCachedTokens(span.usageRaw) ?? 'n/a'}</td>
                      <td>{span.cacheWriteTokens ?? 'n/a'}</td>
                      <td>
                        {span.usageRaw ? (
                          <details className="usage-details">
                            <summary className="usage-summary">View</summary>
                            <pre className="usage-block">
                              {span.usageRaw}
                              {span.usageTruncated ? '\n…(truncated)' : ''}
                            </pre>
                          </details>
                        ) : (
                          'n/a'
                        )}
                      </td>
                      <td>
                        {span.toolCalls?.length
                          ? span.toolCalls.map((call, idx) => (
                              <span key={`${call.name}-${idx}`} className="tool-chip" title={call.inputPreview || ''}>
                                {call.name}
                              </span>
                            ))
                          : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
                <div className="empty">No LLM spans.</div>
              )}
            </section>

            <section className="section">
              <h2>Tool Spans</h2>
              {selectedRun.toolSpans.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Index</th>
                        <th>Name</th>
                        <th>Duration</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRun.toolSpans.map((span) => (
                        <tr key={span.index}>
                          <td>#{span.index}</td>
                          <td>{span.name}</td>
                          <td>{formatDuration(span.durationMs)}</td>
                          <td>{span.inputSize ?? 'n/a'}</td>
                          <td>{span.outputSize ?? 'n/a'}</td>
                          <td>{span.error ? <span className="error">{span.error}</span> : 'ok'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">No tool spans.</div>
              )}
            </section>
          </>
        ) : detailTab === 'prompt' ? (
          <PromptView apiBase={apiBase} run={selectedRun} />
        ) : detailTab === 'timeline' ? (
          <>
            <section className="section">
              <h2>Summary Timeline</h2>
              <div className="legend">
                <span className="legend-item">
                  <span className="legend-swatch swatch-llm" /> LLM
                </span>
                <span className="legend-item">
                  <span className="legend-swatch swatch-tool" /> Tool
                </span>
                <span className="legend-item">
                  <span className="legend-swatch swatch-hook" /> Plugin Hook
                </span>
              </div>
              {maxTurn > 1 ? (
                <div className="timeline-filter">
                  <label>
                    From
                    <select
                      value={rangeFrom}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          from: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`from-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      value={rangeTo}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          to: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`to-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              {timelineAll.length ? (
                <div className="timeline">
                  {timelineRows.map((row) => {
                    if (row.type === 'separator') {
                      return (
                        <div key={row.key} className="timeline-divider">
                          <span>{row.label}</span>
                        </div>
                      );
                    }
                    const event = row.event;
                    const left = ((event.start - runStart) / runDuration) * 100;
                    const width = ((event.end - event.start) / runDuration) * 100;
                    return (
                      <div key={row.key} className={`timeline-row ${event.type}`}>
                        <div className="timeline-label">{event.label}</div>
                        <div className="timeline-track" data-tooltip={event.tooltip}>
                          <div
                            className="timeline-bar"
                            style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(2, width)}%` }}
                          />
                        </div>
                        <div className="timeline-value">{formatDuration(event.duration)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No timeline data yet.</div>
              )}
            </section>

            <section className="section">
              <h2>Idle Gaps (All)</h2>
              {topAllGaps.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Gap</th>
                        <th>Start</th>
                        <th>Between</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topAllGaps.map((gap, idx) => (
                        <tr key={`${gap.start}-${idx}`}>
                          <td>{formatDuration(gap.duration)}</td>
                          <td>{formatTime(gap.start)}</td>
                          <td>
                            {gap.before} → {gap.after}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">No idle gaps detected.</div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="section">
              <h2>Plugin Bottlenecks</h2>
              <div className="hot-grid">
                <div className="hot-card">
                  <div className="hot-label">Slowest hook</div>
                  <div className="hot-value">
                    {slowestHook ? `${slowestHook.pluginName}.${slowestHook.hookName} · ${formatDuration(slowestHook.durationMs)}` : 'n/a'}
                  </div>
                </div>
                <div className="hot-card">
                  <div className="hot-label">Total hook time</div>
                  <div className="hot-value">{formatDuration(totalHookTime)}</div>
                </div>
              </div>

              <div className="bar-block">
                <div className="bar-title">Top plugin hooks</div>
                {topHooks.length ? (
                  topHooks.map((hook, idx) => (
                    <div key={`hook-${idx}`} className="bar-row">
                      <div className="bar-label">{hook.pluginName}.{hook.hookName}</div>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.max(6, (hook.durationMs / (maxHook || 1)) * 100)}%` }}
                        />
                      </div>
                      <div className="bar-value">{formatDuration(hook.durationMs)}</div>
                    </div>
                  ))
                ) : (
                  <div className="empty">No hook timings yet.</div>
                )}
              </div>
            </section>

            <section className="section">
              <h2>Hook Timeline</h2>
              {maxTurn > 1 ? (
                <div className="timeline-filter">
                  <label>
                    From
                    <select
                      value={rangeFrom}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          from: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`hook-from-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      value={rangeTo}
                      onChange={(event) =>
                        setTimelineRange((current) => ({
                          ...current,
                          to: Number(event.target.value),
                        }))
                      }
                    >
                      {Array.from({ length: maxTurn }, (_, idx) => idx + 1).map((turn) => (
                        <option key={`hook-to-${turn}`} value={turn}>
                          T{turn}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
              {timelineHooksFiltered.length ? (
                <div className="timeline">
                  {timelineHookRows.map((row) => {
                    if (row.type === 'separator') {
                      return (
                        <div key={row.key} className="timeline-divider">
                          <span>{row.label}</span>
                        </div>
                      );
                    }
                    const event = row.event;
                    const left = ((event.start - runStart) / runDuration) * 100;
                    const width = ((event.end - event.start) / runDuration) * 100;
                    return (
                      <div key={row.key} className={`timeline-row ${event.type}`}>
                        <div className="timeline-label">{event.label}</div>
                        <div className="timeline-track">
                          <div
                            className="timeline-bar"
                            style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(2, width)}%` }}
                          />
                        </div>
                        <div className="timeline-value">{formatDuration(event.duration)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">No hook timeline data yet.</div>
              )}
            </section>

            <section className="section">
              <h2>Plugin Hooks</h2>
          {pluginHooks.length ? (
            <div className="table-scroll">
              <table>
                    <thead>
                      <tr>
                        <th>Plugin</th>
                        <th>Hook</th>
                        <th>Duration</th>
                        <th>Start</th>
                      </tr>
                    </thead>
                    <tbody>
                  {pluginHooks.map((hook, idx) => (
                    <tr key={`${hook.pluginName}-${hook.hookName}-${idx}`}>
                      <td>{hook.pluginName}</td>
                      <td>{hook.hookName}</td>
                          <td>{formatDuration(hook.durationMs)}</td>
                          <td>{formatTime(hook.startedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">No plugin hooks.</div>
              )}
            </section>

          <section className="section">
              <h2>Compactions</h2>
              {compactionEvents.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Attempt</th>
                        <th>Trigger</th>
                        <th>Reason</th>
                        <th>Tokens</th>
                        <th>Messages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compactionEvents.map((event) => (
                        <tr key={`${event.attempt}-${event.at}`}>
                          <td>#{event.attempt}</td>
                          <td>{event.trigger}</td>
                          <td>{event.reason || event.strategy}</td>
                          <td>
                            {event.beforeEstimatedTokens} → {event.afterEstimatedTokens}
                          </td>
                          <td>
                            {event.beforeMessageCount} → {event.afterMessageCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">No compactions.</div>
              )}
            </section>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="app">
      <header>
        <div className="title-block">
          <h1>Pulse Devtools</h1>
          <p className="subtitle">Run timing, tool spans, and compaction signals from remote-server.</p>
        </div>
        <div className="controls">
          <input
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            onBlur={() => applyBaseUrl(baseUrlInput)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                applyBaseUrl(baseUrlInput);
                loadRuns();
              }
            }}
            placeholder={DEFAULT_BASE_URL}
          />
          <button
            className="button"
            onClick={() => {
              applyBaseUrl(baseUrlInput);
              loadRuns();
            }}
          >
            Refresh
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            Auto refresh
          </label>
        </div>
      </header>

      <div className="page-nav">
        {(['runs', 'stats', 'tools', 'errors'] as const).map((p) => (
          <button
            key={p}
            className={`page-nav-btn ${page === p ? 'active' : ''}`}
            onClick={() => setPage(p)}
          >
            {p === 'runs'
              ? '⚡ Runs'
              : p === 'stats'
              ? '📊 Stats'
              : p === 'tools'
              ? '🧰 Tools'
              : '⚠️ Errors'}
          </button>
        ))}
      </div>

      {page === 'stats' ? (
        <StatsView apiBase={apiBase} />
      ) : page === 'tools' ? (
        <ToolsView apiBase={apiBase} />
      ) : page === 'errors' ? (
        <ErrorsView apiBase={apiBase} />
      ) : (
      <main>
        <section className="panel">
          <div className="panel-header">
            <h2>Runs</h2>
            <span className="pill">{runs.length} total</span>
          </div>
          <div className="filter-row">
            <input
              className="filter-input"
              placeholder="Filter by session_id"
              value={sessionFilter}
              onChange={(event) => setSessionFilter(event.target.value)}
            />
            <div className="status-tabs">
              {(['all', 'running', 'finished'] as const).map((status) => (
                <button
                  key={status}
                  className={`tab-button ${statusFilter === status ? 'active' : ''}`}
                  onClick={() => setStatusFilter(status)}
                >
                  {status}
                </button>
              ))}
            </div>
            <select
              className="filter-select"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as 'none' | 'session')}
            >
              <option value="none">No group</option>
              <option value="session">Group by session</option>
            </select>
            <select
              className="filter-select"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as 'recent' | 'duration' | 'lastEvent')}
            >
              <option value="recent">Sort: recent</option>
              <option value="duration">Sort: duration</option>
              <option value="lastEvent">Sort: last event</option>
            </select>
          </div>
          <div className="list">
            {filteredRuns.length ? (
              groupBy === 'session' && groupedRuns ? (
                Object.entries(groupedRuns).map(([sessionId, items]) => (
                  <div className="group-block" key={sessionId}>
                    <div className="group-title">
                      <span>Session {sessionId}</span>
                      {sessionId !== 'unknown' ? <CopyButton value={sessionId} /> : null}
                    </div>
                    {items.map((run, index) => (
                      <button
                        key={run.runId}
                        className={`run-card ${run.runId === selectedId ? 'active' : ''}`}
                        data-status={run.status}
                        style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
                        onClick={() => setSelectedId(run.runId)}
                      >
                        <div className="run-meta">
                          <span className={`status ${run.status}`}>
                            <span className="status-dot" />
                            {run.status}
                          </span>
                          <span>{formatDuration(run.durationMs || Date.now() - run.startedAt)}</span>
                        </div>
                        <strong>{run.userTextPreview || 'No user text'}</strong>
                        <div className="run-meta">
                          <span className="run-id-line">
                            Run {run.runId.slice(0, 8)}
                            <CopyButton value={run.runId} />
                          </span>
                          <span>Last {formatTime(run.lastEventAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                filteredRuns.map((run, index) => (
                  <button
                    key={run.runId}
                    className={`run-card ${run.runId === selectedId ? 'active' : ''}`}
                    data-status={run.status}
                    style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
                    onClick={() => setSelectedId(run.runId)}
                  >
                    <div className="run-meta">
                      <span className={`status ${run.status}`}>
                        <span className="status-dot" />
                        {run.status}
                      </span>
                      <span>{formatDuration(run.durationMs || Date.now() - run.startedAt)}</span>
                    </div>
                    <strong>{run.userTextPreview || 'No user text'}</strong>
                    <div className="run-meta">
                      <span className="run-id-line">
                        Run {run.runId.slice(0, 8)}
                        <CopyButton value={run.runId} />
                      </span>
                      <span>Last {formatTime(run.lastEventAt)}</span>
                    </div>
                  </button>
                ))
              )
            ) : (
              <div className="empty">No runs yet.</div>
            )}
          </div>
          {listError ? <div className="error">{listError}</div> : null}
        </section>

        <section className="panel panel-detail">
          <h2>Details</h2>
          {renderDetail()}
        </section>
      </main>
      )}
    </div>
  );
}

function InfoCard({ label, value, copyValue }: { label: string; value: string; copyValue?: string }) {
  return (
    <div className="detail-card">
      <h3>{label}</h3>
      <p className="detail-line">
        <span>{value}</span>
        {copyValue ? <CopyButton value={copyValue} /> : null}
      </p>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <button className={`copy-button ${copied ? 'copied' : ''}`} onClick={copy} type="button">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── StatsView ─────────────────────────────────────────────────────────────────

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function BarChart({ buckets, height = 140 }: { buckets: TokenStatsBucket[]; height?: number }) {
  if (!buckets.length) return <div className="empty">No data in this range.</div>;

  const maxVal = Math.max(...buckets.map((b) => b.totalTokens), 1);
  const barW = Math.max(14, Math.min(48, Math.floor(560 / buckets.length) - 4));
  const gap = 4;
  const totalW = buckets.length * (barW + gap) - gap;
  const chartH = height;
  const paddingTop = 20;
  const labelH = 38;
  const svgH = chartH + paddingTop + labelH;

  return (
    <div className="bar-chart-wrap">
      <svg
        viewBox={`0 0 ${Math.max(totalW, 300)} ${svgH}`}
        style={{ width: '100%', height: svgH, display: 'block' }}
        aria-label="Token usage bar chart"
      >
        {buckets.map((b, i) => {
          const x = i * (barW + gap);
          const inH = b.inputTokens > 0 ? Math.max(3, Math.round((b.inputTokens / maxVal) * chartH)) : 0;
          const outH = b.outputTokens > 0 ? Math.max(3, Math.round((b.outputTokens / maxVal) * chartH)) : 0;
          const stackH = inH + outH;
          const y = paddingTop + chartH - stackH;
          const labelText = b.label.length > 8 ? b.label.slice(5) : b.label; // trim year for day/week

          return (
            <g key={b.ts}>
              <title>{`${b.label}\nInput: ${formatK(b.inputTokens)}\nOutput: ${formatK(b.outputTokens)}\nTotal: ${formatK(b.totalTokens)}\nRuns: ${b.runCount}`}</title>
              {/* Output (top) */}
              {outH > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={outH}
                  rx={3}
                  fill="rgba(33,105,185,0.55)"
                />
              )}
              {/* Input (bottom) */}
              {inH > 0 && (
                <rect
                  x={x}
                  y={y + outH}
                  width={barW}
                  height={inH}
                  rx={3}
                  fill="rgba(15,123,108,0.55)"
                />
              )}
              {/* Empty bar placeholder */}
              {stackH === 0 && (
                <rect x={x} y={paddingTop + chartH - 3} width={barW} height={3} rx={2} fill="#e8e7e3" />
              )}
              {/* Label */}
              <text
                x={x + barW / 2}
                y={paddingTop + chartH + 14}
                textAnchor="middle"
                fontSize={9}
                fill="#9b9690"
              >
                {labelText}
              </text>
              {/* Run count */}
              {b.runCount > 0 && (
                <text
                  x={x + barW / 2}
                  y={paddingTop + chartH + 26}
                  textAnchor="middle"
                  fontSize={8}
                  fill="#bbb9b4"
                >
                  {b.runCount}r
                </text>
              )}
            </g>
          );
        })}
        {/* Baseline */}
        <line
          x1={0}
          y1={paddingTop + chartH}
          x2={Math.max(totalW, 300)}
          y2={paddingTop + chartH}
          stroke="#e8e7e3"
          strokeWidth={1}
        />
      </svg>
      <div className="chart-legend">
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'rgba(15,123,108,0.55)' }} />Input</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'rgba(33,105,185,0.55)' }} />Output</span>
      </div>
    </div>
  );
}

function StatsView({ apiBase }: { apiBase: string }) {
  const [range, setRange] = useState<StatsRange>('week');
  const [granularity, setGranularity] = useState<StatsGranularity>('day');
  const [groupBy, setGroupBy] = useState<StatsGroupBy>('none');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tokenStats, setTokenStats] = useState<TokenStatsResponse | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildQuery = () => {
    const params = new URLSearchParams({ range, granularity, groupBy });
    if (range === 'custom') {
      if (customFrom) params.set('from', String(new Date(customFrom).getTime()));
      if (customTo) params.set('to', String(new Date(customTo).getTime()));
    }
    return params.toString();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const q = buildQuery();
      const [tRes, sRes] = await Promise.all([
        fetch(`${apiBase}/stats/tokens?${q}`),
        fetch(`${apiBase}/stats/sessions?${q}`),
      ]);
      if (!tRes.ok || !sRes.ok) throw new Error('Request failed');
      const [tData, sData] = await Promise.all([tRes.json(), sRes.json()]) as [TokenStatsResponse, SessionStatsResponse];
      setTokenStats(tData);
      setSessionStats(sData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [range, granularity, groupBy, apiBase]);

  const summary = tokenStats?.summary;
  const buckets = tokenStats?.buckets ?? [];
  const sessions = sessionStats?.sessions ?? [];
  const maxSessionTokens = Math.max(...sessions.map((s) => s.totalTokens), 1);

  return (
    <div className="stats-view">
      {/* Controls */}
      <div className="stats-controls">
        <div className="stats-range-tabs">
          {(['today', 'week', 'month', 'custom'] as const).map((r) => (
            <button
              key={r}
              className={`tab-button ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'today' ? 'Today' : r === 'week' ? '7 Days' : r === 'month' ? '30 Days' : 'Custom'}
            </button>
          ))}
        </div>
        <div className="stats-granularity">
          <span className="stats-ctrl-label">Granularity</span>
          <select
            className="filter-select"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as StatsGranularity)}
          >
            <option value="hour">Hour</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </div>
        <div className="stats-granularity">
          <span className="stats-ctrl-label">Group by</span>
          <select
            className="filter-select"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as StatsGroupBy)}
          >
            <option value="none">None</option>
            <option value="model">Model</option>
            <option value="session">Session</option>
          </select>
        </div>
        {range === 'custom' && (
          <div className="stats-custom-range">
            <input
              type="date"
              className="filter-input"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span>→</span>
            <input
              type="date"
              className="filter-input"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
            <button className="button" onClick={load}>Apply</button>
          </div>
        )}
        {loading && <span className="stats-loading">Loading…</span>}
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Summary Cards */}
      {summary && (
        <div className="stats-cards">
          <StatCard label="Total Runs" value={String(summary.totalRuns)} />
          <StatCard
            label="Input Tokens"
            value={formatK(summary.inputTokens)}
            sub={`+${formatK(summary.cacheReadTokens)} cache hit`}
          />
          <StatCard label="Output Tokens" value={formatK(summary.outputTokens)} />
          <StatCard label="Total Tokens" value={formatK(summary.totalTokens)} />
          {summary.costUsd !== undefined && (
            <StatCard label="Est. Cost" value={`$${summary.costUsd.toFixed(4)}`} sub="model price table" />
          )}
          {summary.cacheReadTokens > 0 && (
            <StatCard
              label="Cache Read"
              value={formatK(summary.cacheReadTokens)}
              sub={`${Math.round((summary.cacheReadTokens / Math.max(summary.inputTokens, 1)) * 100)}% hit rate`}
            />
          )}
          {summary.cacheWriteTokens > 0 && (
            <StatCard label="Cache Write" value={formatK(summary.cacheWriteTokens)} />
          )}
        </div>
      )}

      {/* Time range label */}
      {tokenStats && (
        <div className="stats-range-label">
          {formatDate(tokenStats.from)} – {formatDate(tokenStats.to)}
          <span className="stats-grain-pill">{granularity}</span>
        </div>
      )}

      {/* Bar Chart */}
      <div className="stats-section">
        <h3 className="stats-section-title">Token Usage Over Time</h3>
        <BarChart buckets={buckets} />
      </div>

      {/* Groups (groupBy=model | session) */}
      {tokenStats?.groups && tokenStats.groups.length > 0 && (
        <div className="stats-section">
          <h3 className="stats-section-title">
            Breakdown by {groupBy === 'model' ? 'Model' : 'Session'}
          </h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{groupBy === 'model' ? 'Model' : 'Session'}</th>
                  <th>Runs</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache R</th>
                  <th>Total</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {tokenStats.groups.map((g) => (
                  <tr key={g.key}>
                    <td title={g.key}>{g.key.length > 36 ? g.key.slice(0, 36) + '…' : g.key}</td>
                    <td>{g.runCount}</td>
                    <td>{formatK(g.inputTokens)}</td>
                    <td>{formatK(g.outputTokens)}</td>
                    <td>{formatK(g.cacheReadTokens)}</td>
                    <td>{formatK(g.totalTokens)}</td>
                    <td>{g.costUsd !== undefined ? `$${g.costUsd.toFixed(4)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Session Breakdown */}
      <div className="stats-section">
        <h3 className="stats-section-title">Session Breakdown</h3>
        {sessions.length > 0 ? (
          <div className="stats-session-list">
            {sessions.map((s) => {
              const pct = Math.round((s.totalTokens / maxSessionTokens) * 100);
              return (
                <div key={s.sessionId} className="stats-session-row">
                  <div className="stats-session-meta">
                    <span className="stats-session-id" title={s.sessionId}>
                      {s.sessionId === 'unknown' ? '(unknown)' : s.sessionId.slice(0, 24)}
                    </span>
                    <span className="stats-session-runs">{s.runCount} runs</span>
                    <span className="stats-session-last">last {formatDate(s.lastRunAt)}</span>
                  </div>
                  <div className="stats-session-bar-row">
                    <div className="bar-track" style={{ flex: 1 }}>
                      <div className="bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="bar-value">{formatK(s.totalTokens)}</span>
                  </div>
                  <div className="stats-session-tokens">
                    <span>In: {formatK(s.inputTokens)}</span>
                    <span>Out: {formatK(s.outputTokens)}</span>
                    {s.cacheReadTokens > 0 && <span>Cache: {formatK(s.cacheReadTokens)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty">No session data in this range.</div>
        )}
      </div>
    </div>
  );
}

// ── PromptView ────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Prompt diff helpers ───────────────────────────────────────────────────────

function msgKey(msg: any): string {
  if (typeof msg.content === 'string') return `${msg.role}::${msg.content}`;
  return `${msg.role}::${JSON.stringify(msg.content)}`;
}

/** Returns index of first diverging message (common prefix length).
 *  Skips __gap__ markers when comparing. */
function commonPrefixLen(a: any[], b: any[]): number {
  // Strip gap markers for comparison
  const cleanA = a.filter((m) => m.role !== '__gap__');
  const cleanB = b.filter((m) => m.role !== '__gap__');
  const len = Math.min(cleanA.length, cleanB.length);
  for (let i = 0; i < len; i++) {
    if (msgKey(cleanA[i]) !== msgKey(cleanB[i])) return i;
  }
  return len;
}

/** Map clean-index prefix len back to original array index in b (with gaps). */
function prefixLenInRaw(rawB: any[], cleanPrefixLen: number): number {
  let clean = 0;
  for (let i = 0; i < rawB.length; i++) {
    if (rawB[i].role === '__gap__') continue;
    if (clean >= cleanPrefixLen) return i;
    clean++;
  }
  return rawB.length;
}

function roleColor(role: string): string {
  if (role === 'user') return '#1a6b2e';
  if (role === 'assistant') return '#1a4f9c';
  if (role === 'tool' || role === 'tool_result') return '#7a5c00';
  if (role === 'system') return '#6b2fa0';
  return '#555';
}

function roleBg(role: string): string {
  if (role === 'user') return '#e8f5e9';
  if (role === 'assistant') return '#e3edf7';
  if (role === 'tool' || role === 'tool_result') return '#fff3cd';
  if (role === 'system') return '#f8f0fb';
  return '#f0efed';
}

function msgPreview(msg: any, chars = 120): string {
  if (typeof msg.content === 'string') return msg.content.slice(0, chars);
  if (Array.isArray(msg.content)) {
    const t = msg.content.find((c: any) => c.type === 'text');
    return t?.text?.slice(0, chars) ?? `[${msg.content.length} parts]`;
  }
  return '';
}

// ── Single-span message list ──────────────────────────────────────────────────

function MsgList({ messages, truncated, highlight }: {
  messages: any[];
  truncated?: boolean;
  highlight?: (i: number) => 'cached' | 'new' | 'none';
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (messages.length === 0) return <div className="empty">No messages captured.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {messages.map((msg: any, i: number) => {
        // Gap marker row
        if (msg.role === '__gap__') {
          return (
            <div key={i} style={{ textAlign: 'center', padding: '6px 0', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-sidebar)', border: '1px dashed var(--border)', borderRadius: 4 }}>
              {msg.content}
            </div>
          );
        }

        const hl = highlight ? highlight(i) : 'none';
        const isOpen = expanded === i;
        const preview = msgPreview(msg);
        const borderLeft = hl === 'cached'
          ? '3px solid #27ae60'
          : hl === 'new' ? '3px solid #2980b9' : '3px solid transparent';
        return (
          <div key={i} style={{ border: '1px solid var(--border)', borderLeft, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-card)' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', background: 'var(--bg-sidebar)', borderBottom: isOpen ? '1px solid var(--border)' : 'none' }}
              onClick={() => setExpanded(isOpen ? null : i)}
            >
              {hl !== 'none' && (
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 3, background: hl === 'cached' ? '#d4edda' : '#cce5ff', color: hl === 'cached' ? '#155724' : '#004085', minWidth: 38, textAlign: 'center' }}>
                  {hl === 'cached' ? '⚡ hit' : '✦ new'}
                </span>
              )}
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: roleBg(msg.role), color: roleColor(msg.role), minWidth: 60, textAlign: 'center' }}>
                {msg.role}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {preview}{!isOpen && preview.length === 120 ? '…' : ''}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
            </div>
            {isOpen && (
              <div className="mono-block" style={{ margin: 0, borderRadius: 0, maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
              </div>
            )}
          </div>
        );
      })}
      {truncated && <div className="empty" style={{ fontSize: 12 }}>⚠ Snapshot truncated — older messages not shown.</div>}
    </div>
  );
}

// ── Cache Diff View ───────────────────────────────────────────────────────────

function CacheDiffView({ apiBase, run, llmSpans }: {
  apiBase: string;
  run: RunDetail;
  llmSpans: LlmSpan[];
}) {
  const defaultA = llmSpans.length >= 2 ? llmSpans[llmSpans.length - 2].index : llmSpans[0].index;
  const defaultB = llmSpans[llmSpans.length - 1].index;

  const [spanA, setSpanA] = useState(defaultA);
  const [spanB, setSpanB] = useState(defaultB);
  const [snapshotA, setSnapshotA] = useState<LlmPromptSnapshot | null>(null);
  const [snapshotB, setSnapshotB] = useState<LlmPromptSnapshot | null>(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);
  const [errorA, setErrorA] = useState<string | null>(null);
  const [errorB, setErrorB] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState<'side' | 'b-only'>('b-only');

  const fetchSnap = async (idx: number, set: (s: LlmPromptSnapshot | null) => void, setL: (b: boolean) => void, setE: (s: string | null) => void) => {
    setL(true); setE(null);
    try {
      const res = await fetch(`${apiBase}/runs/${run.runId}/llm/${idx}`);
      const data = await res.json();
      if (!data.ok || !data.snapshot) throw new Error(data.error ?? 'No snapshot');
      set(data.snapshot as LlmPromptSnapshot);
    } catch (e) { setE(e instanceof Error ? e.message : String(e)); set(null); }
    finally { setL(false); }
  };

  useEffect(() => { fetchSnap(spanA, setSnapshotA, setLoadingA, setErrorA); }, [spanA, run.runId]);
  useEffect(() => { fetchSnap(spanB, setSnapshotB, setLoadingB, setErrorB); }, [spanB, run.runId]);

  const spanInfoA = llmSpans.find((s) => s.index === spanA);
  const spanInfoB = llmSpans.find((s) => s.index === spanB);

  // Diff analysis
  const sysMatch = snapshotA && snapshotB
    ? (snapshotA.systemPrompt ?? '') === (snapshotB.systemPrompt ?? '')
    : null;
  // Clean prefix length (ignoring __gap__ markers)
  const cleanPrefixLen = snapshotA && snapshotB
    ? commonPrefixLen(snapshotA.messages, snapshotB.messages)
    : 0;
  // Raw index boundary in B's message array (accounting for gap markers)
  const rawPrefixBoundary = snapshotB
    ? prefixLenInRaw(snapshotB.messages, cleanPrefixLen)
    : 0;
  // Count non-gap new messages in B beyond the prefix
  const newMsgs = snapshotB
    ? snapshotB.messages.slice(rawPrefixBoundary).filter((m: any) => m.role !== '__gap__').length
    : 0;
  const totalMsgCountB = snapshotB?.totalMessageCount ?? snapshotB?.messages.filter((m: any) => m.role !== '__gap__').length ?? 0;
  const skippedB = snapshotB?.skippedMessages ?? 0;
  const cacheRead = spanInfoB?.cacheReadTokens ?? 0;
  const cacheWrite = spanInfoB?.cacheWriteTokens ?? 0;
  const inputB = spanInfoB?.inputTokens ?? 0;
  const cacheHitRate = inputB > 0 ? Math.round((cacheRead / inputB) * 100) : 0;

  const loading = loadingA || loadingB;

  return (
    <div className="stats-view">
      {/* Span selectors */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#27ae60', minWidth: 14 }}>A</span>
          <select className="filter-select" value={spanA} onChange={(e: any) => setSpanA(Number(e.target.value))}>
            {llmSpans.map((s) => (
              <option key={s.index} value={s.index}>#{s.index}{s.durationMs !== undefined ? ` · ${formatDuration(s.durationMs)}` : ''}</option>
            ))}
          </select>
        </div>
        <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>→</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#2980b9', minWidth: 14 }}>B</span>
          <select className="filter-select" value={spanB} onChange={(e: any) => setSpanB(Number(e.target.value))}>
            {llmSpans.map((s) => (
              <option key={s.index} value={s.index}>#{s.index}{s.durationMs !== undefined ? ` · ${formatDuration(s.durationMs)}` : ''}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button className={`tab-button ${showPanel === 'b-only' ? 'active' : ''}`} style={{ fontSize: 11 }} onClick={() => setShowPanel('b-only')}>B 视角</button>
          <button className={`tab-button ${showPanel === 'side' ? 'active' : ''}`} style={{ fontSize: 11 }} onClick={() => setShowPanel('side')}>并排</button>
        </div>
        {loading && <span className="stats-loading">Loading…</span>}
      </div>

      {(errorA || errorB) && <div className="error" style={{ marginBottom: 10 }}>{errorA ?? errorB}</div>}

      {/* Cache analysis cards */}
      {snapshotA && snapshotB && (
        <>
          <div className="stats-cards" style={{ marginBottom: 14 }}>
            <StatCard
              label="System Prompt"
              value={sysMatch ? '✓ Same' : '✗ Changed'}
              sub={sysMatch ? 'full match → cached' : 'mismatch → cache miss'}
            />
            <StatCard
              label="Prefix (msgs cached)"
              value={`${cleanPrefixLen} msgs`}
              sub={`of ${snapshotA.messages.filter((m: any) => m.role !== '__gap__').length} in A`}
            />
            <StatCard
              label="New Messages (B)"
              value={`+${newMsgs} msgs`}
              sub={skippedB > 0 ? `total ${totalMsgCountB} (${skippedB} skipped)` : `total ${totalMsgCountB}`}
            />
            <StatCard
              label="Cache Read (B)"
              value={cacheRead > 0 ? formatK(cacheRead) : '0'}
              sub={cacheRead > 0 ? `${cacheHitRate}% of input tokens` : 'no cache hit'}
            />
            {cacheWrite > 0 && (
              <StatCard label="Cache Write (B)" value={formatK(cacheWrite)} sub="new prefix stored" />
            )}
            <StatCard
              label="Input Tokens (B)"
              value={formatK(inputB)}
              sub={spanInfoB?.model ?? undefined}
            />
          </div>

          {/* Cache boundary visualization */}
          {snapshotB.messages.length > 0 && (
            <div className="stats-section" style={{ marginBottom: 14 }}>
              <h3 className="stats-section-title">缓存边界可视化</h3>
              <div style={{ display: 'flex', gap: 0, height: 28, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
                {/* System prompt */}
                <div style={{ background: sysMatch ? '#27ae60' : '#e74c3c', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 600, maxWidth: 120 }}>
                  SYS {sysMatch ? '⚡' : '✗'}
                </div>
                {/* Cached messages */}
                {cleanPrefixLen > 0 && (
                  <div style={{ background: '#2ecc71', flex: cleanPrefixLen, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 600, minWidth: 40 }}>
                    ⚡ {cleanPrefixLen} msgs
                  </div>
                )}
                {/* New messages */}
                {newMsgs > 0 && (
                  <div style={{ background: '#3498db', flex: newMsgs, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 600, minWidth: 40 }}>
                    ✦ +{newMsgs} new
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#27ae60', borderRadius: 2, marginRight: 4 }} />system match</span>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#2ecc71', borderRadius: 2, marginRight: 4 }} />cached prefix</span>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#3498db', borderRadius: 2, marginRight: 4 }} />new (not cached)</span>
                {!sysMatch && <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#e74c3c', borderRadius: 2, marginRight: 4 }} />system changed</span>}
              </div>
            </div>
          )}
        </>
      )}

      {/* Message panels */}
      {snapshotA && snapshotB && (
        showPanel === 'side' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#27ae60', marginBottom: 8 }}>
                A — Span #{spanA} · {snapshotA.messages.length} msgs
              </div>
              <MsgList
                messages={snapshotA.messages}
                truncated={snapshotA.messagesTruncated}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#2980b9', marginBottom: 8 }}>
                B — Span #{spanB} · {snapshotB.messages.length} msgs
                {cacheRead > 0 && <span style={{ marginLeft: 8, fontSize: 11, color: '#27ae60' }}>⚡ {formatK(cacheRead)} cache read</span>}
              </div>
              <MsgList
                messages={snapshotB.messages}
                truncated={snapshotB.messagesTruncated}
                highlight={(i) => i < rawPrefixBoundary ? 'cached' : 'new'}
              />
            </div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#2980b9', marginBottom: 8 }}>
              B — Span #{spanB} · {snapshotB.messages.length} msgs
              {cacheRead > 0 && <span style={{ marginLeft: 8, fontSize: 11, color: '#27ae60' }}>⚡ {formatK(cacheRead)} cache read</span>}
            </div>
            <MsgList
              messages={snapshotB.messages}
              truncated={snapshotB.messagesTruncated}
              highlight={(i) => i < rawPrefixBoundary ? 'cached' : 'new'}
            />
          </div>
        )
      )}
    </div>
  );
}

// ── PromptView ────────────────────────────────────────────────────────────────

function PromptView({ apiBase, run }: { apiBase: string; run: RunDetail | null }) {
  const [viewMode, setViewMode] = useState<'single' | 'diff'>('single');
  const [spanIndex, setSpanIndex] = useState(0);
  const [snapshot, setSnapshot] = useState<LlmPromptSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msgTab, setMsgTab] = useState<'messages' | 'tools'>('messages');

  useEffect(() => {
    setSpanIndex(0);
    setSnapshot(null);
    setError(null);
    setViewMode('single');
  }, [run?.runId]);

  const load = async (idx: number) => {
    if (!run) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/runs/${run.runId}/llm/${idx}`);
      const data = await res.json();
      if (!data.ok || !data.snapshot) throw new Error(data.error ?? 'No snapshot');
      setSnapshot(data.snapshot as LlmPromptSnapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (run && run.llmSpans?.length > 0 && viewMode === 'single') {
      load(spanIndex);
    }
  }, [run?.runId, spanIndex, viewMode]);

  if (!run) {
    return <div className="empty" style={{ padding: '40px 0' }}>Select a run to inspect its prompt.</div>;
  }

  const llmSpans = run.llmSpans ?? [];
  if (llmSpans.length === 0) {
    return <div className="empty" style={{ padding: '40px 0' }}>No LLM spans recorded for this run.</div>;
  }

  const currentSpan = llmSpans[spanIndex];

  return (
    <div className="stats-view">
      {/* Mode switcher */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button
          className={`tab-button ${viewMode === 'single' ? 'active' : ''}`}
          onClick={() => setViewMode('single')}
        >
          单次查看
        </button>
        <button
          className={`tab-button ${viewMode === 'diff' ? 'active' : ''}`}
          onClick={() => setViewMode('diff')}
          disabled={llmSpans.length < 2}
          title={llmSpans.length < 2 ? '需要至少 2 次 LLM 调用' : '对比两次调用的 prompt 缓存'}
        >
          ⚡ Cache Diff
        </button>
      </div>

      {/* Cache Diff Mode */}
      {viewMode === 'diff' && (
        <CacheDiffView apiBase={apiBase} run={run} llmSpans={llmSpans} />
      )}

      {/* Single Mode */}
      {viewMode === 'single' && <>

      {/* Span selector */}
      <div className="stats-controls" style={{ marginBottom: 12 }}>
        <div className="stats-range-tabs">
          {llmSpans.map((span, i) => (
            <button
              key={span.index}
              className={`tab-button ${spanIndex === i ? 'active' : ''}`}
              onClick={() => setSpanIndex(i)}
            >
              #{span.index}
              {span.durationMs !== undefined ? ` · ${formatDuration(span.durationMs)}` : ''}
            </button>
          ))}
        </div>
        {loading && <span className="stats-loading" style={{ marginLeft: 12 }}>Loading…</span>}
      </div>

      {/* Span meta cards */}
      {currentSpan && (
        <div className="stats-cards">
          <StatCard label="Model" value={currentSpan.model ?? '—'} />
          <StatCard label="Duration" value={formatDuration(currentSpan.durationMs)} />
          <StatCard label="Finish" value={currentSpan.finishReason ?? '—'} />
          <StatCard
            label="Tokens In / Out"
            value={`${formatK(currentSpan.inputTokens ?? 0)} / ${formatK(currentSpan.outputTokens ?? 0)}`}
            sub={currentSpan.cacheReadTokens ? `+${formatK(currentSpan.cacheReadTokens)} cache` : undefined}
          />
          {currentSpan.messagesBytes !== undefined && (
            <StatCard
              label="Prompt Size"
              value={formatBytes(currentSpan.messagesBytes)}
              sub={currentSpan.promptTruncated ? '⚠ truncated' : undefined}
            />
          )}
          {currentSpan.messageCount !== undefined && (
            <StatCard label="Messages" value={String(currentSpan.messageCount)} />
          )}
        </div>
      )}

      {currentSpan?.errorMessage && (
        <div className="error" style={{ marginBottom: 12 }}>
          LLM Error: {currentSpan.errorMessage}
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {snapshot && (
        <>
          {/* System Prompt */}
          {snapshot.systemPrompt && (
            <div className="stats-section">
              <h3 className="stats-section-title">
                System Prompt
                {snapshot.systemPromptTruncated && (
                  <span className="pill" style={{ marginLeft: 8, background: '#fff3cd', color: '#856404' }}>truncated</span>
                )}
                {snapshot.systemPrompt && (
                  <span style={{ marginLeft: 'auto' }}>
                    <CopyButton value={snapshot.systemPrompt} />
                  </span>
                )}
              </h3>
              <div className="mono-block" style={{ maxHeight: 240, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {snapshot.systemPrompt}
              </div>
            </div>
          )}

          {/* Messages / Tools tabs */}
          <div className="stats-section">
            <div className="detail-tabs" style={{ marginBottom: 12 }}>
              <button
                className={`tab-button ${msgTab === 'messages' ? 'active' : ''}`}
                onClick={() => setMsgTab('messages')}
              >
                Messages ({snapshot.messages.length}
                {snapshot.messagesTruncated ? '+' : ''})
              </button>
              {snapshot.toolNames && snapshot.toolNames.length > 0 && (
                <button
                  className={`tab-button ${msgTab === 'tools' ? 'active' : ''}`}
                  onClick={() => setMsgTab('tools')}
                >
                  Tools ({snapshot.toolNames.length})
                </button>
              )}
            </div>

            {msgTab === 'messages' && (
              snapshot.messages.length === 0 ? (
                <div className="empty">No messages captured.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {snapshot.messages.map((msg: any, i: number) => {
                    const role: string = msg.role ?? 'unknown';
                    const isExpanded = expandedIdx === i;
                    let preview = '';
                    if (typeof msg.content === 'string') {
                      preview = msg.content.slice(0, 160);
                    } else if (Array.isArray(msg.content)) {
                      const first = msg.content.find((c: any) => c.type === 'text');
                      preview = first?.text?.slice(0, 160) ?? `[${msg.content.length} parts]`;
                    }
                    const roleColor = role === 'user' ? '#1a6b2e' : role === 'assistant' ? '#1a4f9c' : '#7a5c00';
                    return (
                      <div
                        key={i}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          overflow: 'hidden',
                          background: 'var(--bg-card)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 10px',
                            cursor: 'pointer',
                            background: 'var(--bg-sidebar)',
                            borderBottom: isExpanded ? '1px solid var(--border)' : 'none',
                          }}
                          onClick={() => setExpandedIdx(isExpanded ? null : i)}
                        >
                          <span style={{
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            color: roleColor,
                            minWidth: 72,
                          }}>
                            {role}
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {preview}{!isExpanded && preview.length === 160 ? '…' : ''}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {isExpanded ? '▲' : '▼'}
                          </span>
                        </div>
                        {isExpanded && (
                          <div className="mono-block" style={{ margin: 0, borderRadius: 0, maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {typeof msg.content === 'string'
                              ? msg.content
                              : JSON.stringify(msg.content, null, 2)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {snapshot.messagesTruncated && (
                    <div className="empty" style={{ fontSize: 12 }}>
                      ⚠ Snapshot was truncated — older messages not shown.
                    </div>
                  )}
                </div>
              )
            )}

            {msgTab === 'tools' && snapshot.toolNames && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {snapshot.toolNames.map((t) => (
                  <span key={t} className="pill">{t}</span>
                ))}
              </div>
            )}
          </div>

          {/* Footer info */}
          {snapshot.totalBytes !== undefined && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Snapshot size: {formatBytes(snapshot.totalBytes)}
              {' · '}Captured: {new Date(snapshot.capturedAt).toLocaleString()}
            </div>
          )}
        </>
      )}
      </>}
    </div>
  );
}

// ── ToolsView ─────────────────────────────────────────────────────────────────

function ToolsView({ apiBase }: { apiBase: string }) {
  const [range, setRange] = useState<StatsRange>('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [data, setData] = useState<ToolStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'count' | 'avgDurationMs' | 'errorRate' | 'p95DurationMs'>('count');

  const buildQuery = () => {
    const params = new URLSearchParams({ range });
    if (range === 'custom') {
      if (customFrom) params.set('from', String(new Date(customFrom).getTime()));
      if (customTo) params.set('to', String(new Date(customTo).getTime()));
    }
    if (sessionId.trim()) params.set('sessionId', sessionId.trim());
    return params.toString();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/stats/tools?${buildQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ToolStatsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [range, apiBase]);

  const tools = [...(data?.tools ?? [])].sort((a, b) => b[sortKey] - a[sortKey]);
  const maxCount = Math.max(...tools.map((t) => t.count), 1);

  return (
    <div className="stats-view">
      {/* Controls */}
      <div className="stats-controls">
        <div className="stats-range-tabs">
          {(['today', 'week', 'month', 'custom'] as const).map((r) => (
            <button
              key={r}
              className={`tab-button ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'today' ? 'Today' : r === 'week' ? '7 Days' : r === 'month' ? '30 Days' : 'Custom'}
            </button>
          ))}
        </div>
        <input
          className="filter-input"
          placeholder="Filter session ID"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          style={{ width: 200 }}
        />
        {range === 'custom' && (
          <div className="stats-custom-range">
            <input type="date" className="filter-input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span>→</span>
            <input type="date" className="filter-input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            <button className="button" onClick={load}>Apply</button>
          </div>
        )}
        {loading && <span className="stats-loading">Loading…</span>}
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Summary Cards */}
      {data && (
        <div className="stats-cards">
          <StatCard label="Total Calls" value={formatK(data.totalCalls)} />
          <StatCard label="Unique Tools" value={String(data.tools.length)} />
          {data.tools.length > 0 && (
            <StatCard
              label="Most Used"
              value={data.tools.reduce((a, b) => a.count >= b.count ? a : b).name}
            />
          )}
          {data.tools.length > 0 && (
            <StatCard
              label="Avg Duration"
              value={formatDuration(
                Math.round(data.tools.reduce((s, t) => s + t.avgDurationMs * t.count, 0) / Math.max(data.totalCalls, 1))
              )}
            />
          )}
        </div>
      )}

      {data && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          {formatDate(data.from)} – {formatDate(data.to)}
        </div>
      )}

      {/* Sort controls */}
      {tools.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sort by</span>
          {([
            ['count', 'Calls'],
            ['avgDurationMs', 'Avg Duration'],
            ['p95DurationMs', 'p95'],
            ['errorRate', 'Error Rate'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={`tab-button ${sortKey === key ? 'active' : ''}`}
              style={{ fontSize: 11, padding: '3px 9px' }}
              onClick={() => setSortKey(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Bar visualization */}
      {tools.length > 0 && (
        <div className="stats-section">
          <h3 className="stats-section-title">Call Count by Tool</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {tools.slice(0, 20).map((t) => {
              const pct = Math.round((t.count / maxCount) * 100);
              return (
                <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={t.name}>
                    {t.name}
                  </span>
                  <div className="bar-track" style={{ flex: 1 }}>
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="bar-value">{formatK(t.count)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Table */}
      {tools.length > 0 ? (
        <div className="stats-section">
          <h3 className="stats-section-title">Detailed Stats</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                  <th>Errors</th>
                  <th>Err Rate</th>
                  <th>Avg</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>Max</th>
                  <th>Avg Input</th>
                  <th>Avg Output</th>
                  <th>Last Used</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.name}>
                    <td title={t.name} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {t.name.length > 30 ? t.name.slice(0, 30) + '…' : t.name}
                    </td>
                    <td>{formatK(t.count)}</td>
                    <td style={{ color: t.errorCount > 0 ? '#c0392b' : undefined }}>{t.errorCount}</td>
                    <td style={{ color: t.errorRate > 0.1 ? '#c0392b' : undefined }}>
                      {(t.errorRate * 100).toFixed(1)}%
                    </td>
                    <td>{formatDuration(t.avgDurationMs)}</td>
                    <td>{formatDuration(t.p50DurationMs)}</td>
                    <td>{formatDuration(t.p95DurationMs)}</td>
                    <td>{formatDuration(t.maxDurationMs)}</td>
                    <td>{t.avgInputBytes > 0 ? formatBytes(t.avgInputBytes) : '—'}</td>
                    <td>{t.avgOutputBytes > 0 ? formatBytes(t.avgOutputBytes) : '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDate(t.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        !loading && <div className="empty">No tool usage data in this range.</div>
      )}
    </div>
  );
}

// ── ErrorsView ────────────────────────────────────────────────────────────────

function ErrorsView({ apiBase }: { apiBase: string }) {
  const [range, setRange] = useState<StatsRange>('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'tool' | 'llm'>('all');
  const [data, setData] = useState<ErrorsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgg, setExpandedAgg] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'aggregate' | 'list'>('aggregate');

  const buildQuery = () => {
    const params = new URLSearchParams({ range, limit: '200' });
    if (range === 'custom') {
      if (customFrom) params.set('from', String(new Date(customFrom).getTime()));
      if (customTo) params.set('to', String(new Date(customTo).getTime()));
    }
    if (sessionId.trim()) params.set('sessionId', sessionId.trim());
    return params.toString();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/errors?${buildQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ErrorsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [range, apiBase]);

  const aggregates = (data?.aggregates ?? []).filter(
    (a) => sourceFilter === 'all' || a.source === sourceFilter
  );
  const entries = (data?.entries ?? []).filter(
    (e) => sourceFilter === 'all' || e.source === sourceFilter
  );

  const toolErrors = data?.aggregates.filter((a) => a.source === 'tool').reduce((s, a) => s + a.count, 0) ?? 0;
  const llmErrors = data?.aggregates.filter((a) => a.source === 'llm').reduce((s, a) => s + a.count, 0) ?? 0;

  return (
    <div className="stats-view">
      {/* Controls */}
      <div className="stats-controls">
        <div className="stats-range-tabs">
          {(['today', 'week', 'month', 'custom'] as const).map((r) => (
            <button
              key={r}
              className={`tab-button ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'today' ? 'Today' : r === 'week' ? '7 Days' : r === 'month' ? '30 Days' : 'Custom'}
            </button>
          ))}
        </div>
        <select
          className="filter-select"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | 'tool' | 'llm')}
        >
          <option value="all">All Sources</option>
          <option value="tool">Tool</option>
          <option value="llm">LLM</option>
        </select>
        <input
          className="filter-input"
          placeholder="Filter session ID"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          style={{ width: 200 }}
        />
        {range === 'custom' && (
          <div className="stats-custom-range">
            <input type="date" className="filter-input" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <span>→</span>
            <input type="date" className="filter-input" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            <button className="button" onClick={load}>Apply</button>
          </div>
        )}
        {loading && <span className="stats-loading">Loading…</span>}
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Summary Cards */}
      {data && (
        <div className="stats-cards">
          <StatCard label="Total Errors" value={String(data.total)} />
          <StatCard label="Unique Patterns" value={String(data.aggregates.length)} />
          <StatCard label="Tool Errors" value={String(toolErrors)} />
          <StatCard label="LLM Errors" value={String(llmErrors)} />
        </div>
      )}

      {data && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          {formatDate(data.from)} – {formatDate(data.to)}
        </div>
      )}

      {/* View mode tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button
          className={`tab-button ${viewMode === 'aggregate' ? 'active' : ''}`}
          onClick={() => setViewMode('aggregate')}
        >
          Aggregated ({aggregates.length})
        </button>
        <button
          className={`tab-button ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setViewMode('list')}
        >
          Raw Events ({entries.length})
        </button>
      </div>

      {/* Aggregated view */}
      {viewMode === 'aggregate' && (
        <>
          {aggregates.length === 0 ? (
            !loading && <div className="empty">No errors in this range. 🎉</div>
          ) : (
            <div className="stats-section">
              <h3 className="stats-section-title">Error Patterns</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {aggregates.map((agg, i) => {
                  const isOpen = expandedAgg === i;
                  const sourceBg = agg.source === 'tool' ? '#fff0f0' : '#fff8e6';
                  const sourceFg = agg.source === 'tool' ? '#c0392b' : '#7a5c00';
                  return (
                    <div
                      key={i}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        overflow: 'hidden',
                        background: 'var(--bg-card)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '7px 12px',
                          cursor: 'pointer',
                          background: 'var(--bg-sidebar)',
                          borderBottom: isOpen ? '1px solid var(--border)' : 'none',
                        }}
                        onClick={() => setExpandedAgg(isOpen ? null : i)}
                      >
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          background: sourceBg,
                          color: sourceFg,
                          padding: '2px 7px',
                          borderRadius: 4,
                          minWidth: 36,
                          textAlign: 'center',
                        }}>
                          {agg.source}
                        </span>
                        <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}
                          title={agg.message}>
                          {agg.message.length > 100 ? agg.message.slice(0, 100) + '…' : agg.message}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#c0392b', minWidth: 32, textAlign: 'right' }}>
                          ×{agg.count}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 80, textAlign: 'right' }}>
                          last {formatDate(agg.lastAt)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
                      </div>
                      {isOpen && (
                        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>FULL MESSAGE</div>
                            <div className="mono-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto' }}>
                              {agg.message}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                              TOOLS / NAMES ({agg.names.length})
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {agg.names.map((n) => <span key={n} className="pill">{n}</span>)}
                            </div>
                          </div>
                          {agg.sampleRunIds.length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                                SAMPLE RUN IDS
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                {agg.sampleRunIds.map((rid) => (
                                  <span key={rid} style={{ fontSize: 11, fontFamily: 'monospace', background: '#f0efed', padding: '2px 7px', borderRadius: 4 }}>
                                    {rid.slice(0, 20)}…
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Raw events list */}
      {viewMode === 'list' && (
        <>
          {entries.length === 0 ? (
            !loading && <div className="empty">No error events in this range.</div>
          ) : (
            <div className="stats-section">
              <h3 className="stats-section-title">Raw Error Events ({entries.length})</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Source</th>
                      <th>Name</th>
                      <th>Message</th>
                      <th>Run ID</th>
                      <th>Session</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={i}>
                        <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatTime(e.at)}</td>
                        <td>
                          <span style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            background: e.source === 'tool' ? '#fff0f0' : '#fff8e6',
                            color: e.source === 'tool' ? '#c0392b' : '#7a5c00',
                            padding: '2px 6px',
                            borderRadius: 4,
                          }}>
                            {e.source}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.name}</td>
                        <td title={e.message} style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {e.message}
                        </td>
                        <td style={{ fontSize: 11, fontFamily: 'monospace' }}>
                          {e.runId.slice(0, 16)}…
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {e.sessionId ? e.sessionId.slice(0, 20) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';

type RunStatus = 'running' | 'finished';

interface RunSummary {
  runId: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  lastEventAt: number;
  durationMs?: number;
  sessionId?: string;
  platformKey?: string;
  caller?: string;
  userTextPreview?: string;
  llmCalls: number;
  toolCalls: number;
  compactions: number;
}

interface LlmSpan {
  index: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  finishReason?: string;
  textLength?: number;
  toolCalls?: Array<{
    name: string;
    inputSize?: number;
    inputPreview?: string;
  }>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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

export default function App() {
  const initialBaseUrl = sanitizeBaseUrl(localStorage.getItem('devtoolsBaseUrl') || DEFAULT_BASE_URL);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [baseUrlInput, setBaseUrlInput] = useState(initialBaseUrl);
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

    const totalLlmTime = llmSpans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
    const totalToolTime = toolSpans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
    const totalHookTime = pluginHooks.reduce((sum, hook) => sum + (hook.durationMs ?? 0), 0);
    const totalCacheRead = selectedRun.llmSpans.reduce((sum, span) => sum + (span.cacheReadTokens ?? 0), 0);
    const totalCacheWrite = selectedRun.llmSpans.reduce((sum, span) => sum + (span.cacheWriteTokens ?? 0), 0);
    const hasCacheRead = selectedRun.llmSpans.some((span) => span.cacheReadTokens !== undefined);
    const hasCacheWrite = selectedRun.llmSpans.some((span) => span.cacheWriteTokens !== undefined);

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
    const timelineEvents = [
      ...selectedRun.llmSpans.map((span) => ({
        type: 'llm' as const,
        label: `LLM #${span.index}`,
        start: span.startedAt,
        end: span.endedAt ?? now,
        duration: span.durationMs ?? Math.max(0, now - span.startedAt),
      })),
      ...selectedRun.toolSpans.map((span) => ({
        type: 'tool' as const,
        label: span.name,
        start: span.startedAt,
        end: span.endedAt ?? now,
        duration: span.durationMs ?? Math.max(0, now - span.startedAt),
      })),
      ...pluginHooks.map((hook, idx) => ({
        type: 'hook' as const,
        label: `${hook.pluginName}.${hook.hookName} #${idx + 1}`,
        start: hook.startedAt,
        end: hook.startedAt + hook.durationMs,
        duration: hook.durationMs,
      })),
    ]
      .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end))
      .sort((a, b) => a.start - b.start);

    const gapEvents: Array<{
      start: number;
      end: number;
      duration: number;
      before: string;
      after: string;
    }> = [];
    let lastEnd = runStart;
    let lastLabel = 'Run start';
    for (const event of timelineEvents) {
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

    return (
      <div className="detail">
        <div className="detail-grid">
          <InfoCard label="Status" value={selectedRun.status} />
          <InfoCard label="Duration" value={formatDuration(selectedRun.durationMs || Date.now() - selectedRun.startedAt)} />
          <InfoCard label="Platform" value={selectedRun.platformKey || 'n/a'} />
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
              <div className="hot-label">Slowest hook</div>
              <div className="hot-value">
                {slowestHook ? `${slowestHook.pluginName}.${slowestHook.hookName} · ${formatDuration(slowestHook.durationMs)}` : 'n/a'}
              </div>
            </div>
            <div className="hot-card">
              <div className="hot-label">Total hook time</div>
              <div className="hot-value">{formatDuration(totalHookTime)}</div>
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
          {timelineEvents.length ? (
            <div className="timeline">
              {timelineEvents.map((event, idx) => {
                const left = ((event.start - runStart) / runDuration) * 100;
                const width = ((event.end - event.start) / runDuration) * 100;
                return (
                  <div key={`${event.type}-${idx}`} className={`timeline-row ${event.type}`}>
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
                    <th>Finish</th>
                    <th>Text Len</th>
                    <th>Input Tok</th>
                    <th>Output Tok</th>
                    <th>Cache Read</th>
                    <th>Cache Write</th>
                    <th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRun.llmSpans.map((span) => (
                    <tr key={span.index}>
                      <td>#{span.index}</td>
                      <td>{formatDuration(span.durationMs)}</td>
                      <td>{span.finishReason || 'n/a'}</td>
                      <td>{span.textLength ?? 'n/a'}</td>
                      <td>{span.inputTokens ?? 'n/a'}</td>
                      <td>{span.outputTokens ?? 'n/a'}</td>
                      <td>{span.cacheReadTokens ?? 'n/a'}</td>
                      <td>{span.cacheWriteTokens ?? 'n/a'}</td>
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
                  ))}
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

        <section className="section">
          <h2>Plugin Hooks</h2>
          {selectedRun.pluginHooks.length ? (
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
                  {selectedRun.pluginHooks.map((hook, idx) => (
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
          {selectedRun.compactionEvents.length ? (
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
                  {selectedRun.compactionEvents.map((event) => (
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

        <section className="panel">
          <h2>Details</h2>
          {renderDetail()}
        </section>
      </main>
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

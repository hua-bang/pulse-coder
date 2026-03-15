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
    if (!sessionFilter.trim()) {
      return runs;
    }
    const needle = sessionFilter.trim().toLowerCase();
    return runs.filter((run) => (run.sessionId ?? '').toLowerCase().includes(needle));
  }, [runs, sessionFilter]);

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

    return (
      <div className="detail">
        <div className="detail-grid">
          <InfoCard label="Status" value={selectedRun.status} />
          <InfoCard label="Duration" value={formatDuration(selectedRun.durationMs || Date.now() - selectedRun.startedAt)} />
          <InfoCard label="Platform" value={selectedRun.platformKey || 'n/a'} />
          <InfoCard label="Session" value={selectedRun.sessionId || 'n/a'} />
          <InfoCard label="LLM Calls" value={String(selectedRun.llmCalls)} />
          <InfoCard label="Tool Calls" value={String(selectedRun.toolCalls)} />
          <InfoCard label="Compactions" value={String(selectedRun.compactions)} />
          <InfoCard label="Last Event" value={formatTime(selectedRun.lastEventAt)} />
        </div>

        <div className="pill-row">
          <span className="pill">Run ID: {selectedRun.runId}</span>
          {selectedRun.caller ? <span className="pill">Caller: {selectedRun.caller}</span> : null}
        </div>

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
            <select
              className="filter-select"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as 'none' | 'session')}
            >
              <option value="none">No group</option>
              <option value="session">Group by session</option>
            </select>
          </div>
          <div className="list">
            {filteredRuns.length ? (
              groupBy === 'session' && groupedRuns ? (
                Object.entries(groupedRuns).map(([sessionId, items]) => (
                  <div className="group-block" key={sessionId}>
                    <div className="group-title">Session {sessionId}</div>
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
                          <span>Run {run.runId.slice(0, 8)}</span>
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
                      <span>Run {run.runId.slice(0, 8)}</span>
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

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-card">
      <h3>{label}</h3>
      <p>{value}</p>
    </div>
  );
}

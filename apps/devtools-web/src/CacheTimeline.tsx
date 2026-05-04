import { useMemo } from 'react';

export interface CacheTimelineSpan {
  spanIndex: number;
  runId?: string;
  startedAt?: number;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface Point {
  position: number;
  spanIndex: number;
  runId?: string;
  startedAt?: number;
  model?: string;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  hitRate: number;
  missing: boolean;
}

interface Breakpoint {
  position: number;
  spanIndex: number;
  runId?: string;
  prevPosition: number;
  prevSpanIndex: number;
  prevRunId?: string;
  expected: number;
  actual: number;
  lostTokens: number;
  severity: 'partial' | 'full';
  crossRun: boolean;
}

interface Result {
  points: Point[];
  breakpoints: Breakpoint[];
  summary: {
    callCount: number;
    freshInput: number;
    cacheRead: number;
    cacheWrite: number;
    hitRate: number;
    breakpointCount: number;
    fullBreakpointCount: number;
    totalLostTokens: number;
  };
}

// Inlined to avoid coupling devtools-web with plugin-kit deps; mirrors plugin-kit/devtools.analyzeCacheTimeline.
function analyze(spans: CacheTimelineSpan[], minLost = 1000, minRatio = 0.05): Result {
  const points: Point[] = spans.map((span, idx) => {
    const cacheRead = span.cacheReadTokens ?? 0;
    const cacheWrite = span.cacheWriteTokens ?? 0;
    // The devtools API treats inputTokens as fresh/non-cache input tokens.
    const freshInput = span.inputTokens ?? 0;
    const denom = freshInput + cacheRead;
    return {
      position: idx + 1,
      spanIndex: span.spanIndex,
      runId: span.runId,
      startedAt: span.startedAt,
      model: span.model,
      freshInput,
      cacheRead,
      cacheWrite,
      total: freshInput + cacheRead + cacheWrite,
      hitRate: denom > 0 ? cacheRead / denom : 0,
      missing:
        span.inputTokens === undefined &&
        span.cacheReadTokens === undefined &&
        span.cacheWriteTokens === undefined,
    };
  });

  const breakpoints: Breakpoint[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev.missing || curr.missing) continue;
    const expected = prev.cacheRead + prev.cacheWrite;
    if (expected <= 0) continue;
    const actual = curr.cacheRead;
    const lost = Math.max(0, expected - actual);
    const threshold = Math.max(minLost, expected * minRatio);
    if (lost < threshold) continue;
    breakpoints.push({
      position: curr.position,
      spanIndex: curr.spanIndex,
      runId: curr.runId,
      prevPosition: prev.position,
      prevSpanIndex: prev.spanIndex,
      prevRunId: prev.runId,
      expected,
      actual,
      lostTokens: lost,
      severity: actual === 0 ? 'full' : 'partial',
      crossRun: !!(prev.runId && curr.runId && prev.runId !== curr.runId),
    });
  }

  let freshInput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let lost = 0;
  for (const p of points) {
    freshInput += p.freshInput;
    cacheRead += p.cacheRead;
    cacheWrite += p.cacheWrite;
  }
  for (const b of breakpoints) lost += b.lostTokens;
  const denom = freshInput + cacheRead;

  return {
    points,
    breakpoints,
    summary: {
      callCount: points.length,
      freshInput,
      cacheRead,
      cacheWrite,
      hitRate: denom > 0 ? cacheRead / denom : 0,
      breakpointCount: breakpoints.length,
      fullBreakpointCount: breakpoints.filter((b) => b.severity === 'full').length,
      totalLostTokens: lost,
    },
  };
}

function formatK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

interface Props {
  spans: CacheTimelineSpan[];
  /** When true, color-band by runId at the bottom (cross-run / session view). */
  showRunBands?: boolean;
  onSpanClick?: (point: Point) => void;
  emptyHint?: string;
}

export function CacheTimeline({ spans, showRunBands, onSpanClick, emptyHint }: Props) {
  const result = useMemo(() => analyze(spans), [spans]);
  const { points, breakpoints, summary } = result;

  if (!points.length) {
    return <div className="empty">{emptyHint ?? 'No LLM calls.'}</div>;
  }

  const maxTotal = Math.max(...points.map((p) => p.total), 1);
  const breakpointMap = new Map<number, Breakpoint>();
  for (const b of breakpoints) breakpointMap.set(b.position, b);

  // Build run color bands
  const runColors = new Map<string, string>();
  if (showRunBands) {
    const palette = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];
    let idx = 0;
    for (const p of points) {
      const key = p.runId ?? 'unknown';
      if (!runColors.has(key)) {
        runColors.set(key, palette[idx % palette.length]);
        idx += 1;
      }
    }
  }

  const allHaveData = summary.cacheRead + summary.cacheWrite + summary.freshInput > 0;

  return (
    <div className="cache-timeline">
      <div className="cache-summary-row">
        <SummaryStat label="Calls" value={String(summary.callCount)} />
        <SummaryStat label="Hit Rate" value={`${(summary.hitRate * 100).toFixed(1)}%`} />
        <SummaryStat label="Cache Read" value={formatK(summary.cacheRead)} accent="green" />
        <SummaryStat label="Cache Write" value={formatK(summary.cacheWrite)} accent="blue" />
        <SummaryStat label="Fresh Input" value={formatK(summary.freshInput)} accent="gray" />
        <SummaryStat
          label="Breakpoints"
          value={`${summary.breakpointCount}${summary.fullBreakpointCount > 0 ? ` (${summary.fullBreakpointCount} full)` : ''}`}
          accent={summary.breakpointCount > 0 ? 'red' : undefined}
        />
        <SummaryStat
          label="Lost Tokens"
          value={formatK(summary.totalLostTokens)}
          accent={summary.totalLostTokens > 0 ? 'red' : undefined}
        />
      </div>

      {!allHaveData ? (
        <div className="cache-empty-note">
          ⚠️ All cache fields are 0. Either prompt caching is not enabled upstream, or no qualifying LLM call has run yet.
        </div>
      ) : null}

      <div className="cache-bars-container">
        {points.map((p, i) => {
          const bp = breakpointMap.get(p.position);
          const heightPct = (p.total / maxTotal) * 100;
          const readPct = p.total > 0 ? (p.cacheRead / p.total) * 100 : 0;
          const writePct = p.total > 0 ? (p.cacheWrite / p.total) * 100 : 0;
          const freshPct = p.total > 0 ? (p.freshInput / p.total) * 100 : 0;
          const tooltip = [
            `#${p.spanIndex}${p.runId ? ` (run ${p.runId.slice(0, 8)})` : ''}`,
            p.model ? `model: ${p.model}` : null,
            `fresh: ${formatK(p.freshInput)}`,
            `cacheRead: ${formatK(p.cacheRead)}`,
            `cacheWrite: ${formatK(p.cacheWrite)}`,
            `hit rate: ${(p.hitRate * 100).toFixed(1)}%`,
            bp
              ? `⚡ ${bp.severity === 'full' ? 'FULL BREAK' : 'partial break'}: lost ${formatK(bp.lostTokens)} (expected ${formatK(bp.expected)}, got ${formatK(bp.actual)})${bp.crossRun ? ' [cross-run]' : ''}`
              : null,
          ]
            .filter(Boolean)
            .join('\n');

          return (
            <div
              key={`${p.runId ?? 'r'}-${p.spanIndex}-${i}`}
              className="cache-bar-cell"
              title={tooltip}
              onClick={onSpanClick ? () => onSpanClick(p) : undefined}
              style={{ cursor: onSpanClick ? 'pointer' : 'default' }}
            >
              {bp ? (
                <div className={`cache-break-marker ${bp.severity}`} title={tooltip}>
                  ⚡{formatK(bp.lostTokens)}
                </div>
              ) : (
                <div className="cache-break-marker placeholder" />
              )}
              <div className="cache-bar-stack" style={{ height: `${Math.max(heightPct, 2)}%` }}>
                {p.cacheRead > 0 ? (
                  <div className="cache-seg seg-read" style={{ height: `${readPct}%` }} />
                ) : null}
                {p.cacheWrite > 0 ? (
                  <div className="cache-seg seg-write" style={{ height: `${writePct}%` }} />
                ) : null}
                {p.freshInput > 0 ? (
                  <div className="cache-seg seg-fresh" style={{ height: `${freshPct}%` }} />
                ) : null}
                {p.total === 0 ? <div className="cache-seg seg-empty" /> : null}
              </div>
              {showRunBands ? (
                <div
                  className="cache-runband"
                  style={{ background: runColors.get(p.runId ?? 'unknown') ?? '#888' }}
                />
              ) : null}
              <div className="cache-bar-label">#{p.spanIndex}</div>
            </div>
          );
        })}
      </div>

      <div className="cache-legend">
        <LegendDot color="#10b981" label="Cache Read (hit)" />
        <LegendDot color="#3b82f6" label="Cache Write (new)" />
        <LegendDot color="#9ca3af" label="Fresh Input (uncached)" />
        <LegendDot color="#ef4444" label="⚡ breakpoint" />
        {showRunBands ? <span className="legend-note">color band = runId</span> : null}
      </div>

      {breakpoints.length > 0 ? (
        <details className="cache-break-details" open>
          <summary>
            {breakpoints.length} breakpoint{breakpoints.length > 1 ? 's' : ''} detected
          </summary>
          <table className="cache-break-table">
            <thead>
              <tr>
                <th>At</th>
                <th>Prev</th>
                <th>Expected ≥</th>
                <th>Actual</th>
                <th>Lost</th>
                <th>Severity</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {breakpoints.map((b) => (
                <tr key={`${b.runId ?? ''}-${b.spanIndex}`} className={`break-row ${b.severity}`}>
                  <td>
                    #{b.spanIndex}
                    {b.runId ? ` (${b.runId.slice(0, 6)})` : ''}
                  </td>
                  <td>
                    #{b.prevSpanIndex}
                    {b.prevRunId ? ` (${b.prevRunId.slice(0, 6)})` : ''}
                  </td>
                  <td>{formatK(b.expected)}</td>
                  <td>{formatK(b.actual)}</td>
                  <td>
                    <strong>{formatK(b.lostTokens)}</strong>
                  </td>
                  <td>{b.severity === 'full' ? 'FULL' : 'partial'}</td>
                  <td>{b.crossRun ? 'cross-run boundary' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'blue' | 'red' | 'gray';
}) {
  return (
    <div className={`cache-summary-stat ${accent ? `accent-${accent}` : ''}`}>
      <div className="cache-summary-label">{label}</div>
      <div className="cache-summary-value">{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-item">
      <span className="legend-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

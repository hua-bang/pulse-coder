import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Context, EnginePlugin, OnCompactedEvent, Tool, ToolExecutionContext } from 'pulse-coder-engine';

type RunStatus = 'running' | 'finished';

export interface DevtoolsRunSummary {
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
  /** Distinct model identifiers used in this run. */
  models?: string[];
  /** Total error count (tool + LLM). */
  errorCount?: number;
  /** Estimated cost in USD (when modelPrices configured). */
  costUsd?: number;
}

export type TokenStatsGranularity = 'hour' | 'day' | 'week';

export interface TokenStatsBucket {
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

export interface TokenStatsSummary {
  totalRuns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface TokenStatsGroupEntry {
  key: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface TokenStatsResult {
  summary: TokenStatsSummary;
  buckets: TokenStatsBucket[];
  groups?: TokenStatsGroupEntry[];
}

export interface TokenStatsOptions {
  from: number;
  to: number;
  granularity?: TokenStatsGranularity;
  sessionId?: string;
  groupBy?: TokenStatsGroupBy;
}

export interface DevtoolsLlmSpan {
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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageRaw?: string;
  usageTruncated?: boolean;
  toolCalls?: Array<{
    name: string;
    inputSize?: number;
    inputPreview?: string;
  }>;
  /** Reference to a separately stored prompt snapshot (runs/<runId>/llm/<index>.json). */
  promptRef?: string;
  /** Inline preview of the system prompt (truncated). */
  systemPromptPreview?: string;
  /** Number of messages sent to the LLM. */
  messageCount?: number;
  /** Names of tools exposed to the LLM in this call. */
  toolNames?: string[];
  /** Total bytes of the message payload (after redaction). */
  messagesBytes?: number;
  /** Whether the snapshot was truncated due to size. */
  promptTruncated?: boolean;
  /** Error message if the LLM call itself failed (network/parse). */
  errorMessage?: string;
}

export interface DevtoolsToolSpan {
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

export interface DevtoolsLlmPromptSnapshot {
  runId: string;
  spanIndex: number;
  capturedAt: number;
  model?: string;
  systemPrompt?: string;
  systemPromptTruncated?: boolean;
  messages: any[];
  /** True when head+tail windowing was applied (middle messages skipped). */
  messagesTruncated?: boolean;
  /** Total message count sent to the LLM (before truncation). */
  totalMessageCount?: number;
  /** Number of messages skipped in the middle (head+tail gap). */
  skippedMessages?: number;
  toolNames?: string[];
  totalBytes?: number;
}

export interface DevtoolsCompactionEvent {
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

export interface DevtoolsRunRecord extends DevtoolsRunSummary {
  endedAt?: number;
  userText?: string;
  callerSelectors?: string[];
  llmSpans: DevtoolsLlmSpan[];
  toolSpans: DevtoolsToolSpan[];
  compactionEvents: DevtoolsCompactionEvent[];
  pluginHooks: DevtoolsPluginHookSpan[];
  resultTextPreview?: string;
}

export interface DevtoolsPluginHookSpan {
  pluginName: string;
  hookName: string;
  startedAt: number;
  durationMs: number;
}

interface DevtoolsRunCreateInput {
  runId: string;
  pluginName?: string;
  pluginVersion?: string;
  sessionId?: string;
  platformKey?: string;
  caller?: string;
  callerSelectors?: string[];
  userText?: string;
}

interface DevtoolsRunListOptions {
  status?: RunStatus;
  limit?: number;
  from?: number;
  to?: number;
  sessionId?: string;
}

interface DevtoolsRunUpdate {
  status?: RunStatus;
  endedAt?: number;
  durationMs?: number;
  resultTextPreview?: string;
}

export interface DevtoolsStoreOptions {
  baseDir?: string;
  flushDelayMs?: number;
  maxEntries?: number;
  saveUserText?: boolean;
  /** Whether to capture LLM prompt/messages snapshots. Default: true. */
  capturePrompts?: boolean;
  /** Per-snapshot byte limit. Default: 256KB. */
  promptSnapshotLimitBytes?: number;
  /** Custom redactor for prompt content. */
  promptRedactor?: (text: string) => string;
  /** Optional model price table for cost calculation (USD per 1M tokens). */
  modelPrices?: Record<string, ModelPriceEntry>;
}

export interface ModelPriceEntry {
  /** USD per 1M input tokens */
  input?: number;
  /** USD per 1M output tokens */
  output?: number;
  /** USD per 1M cache-read tokens */
  cacheRead?: number;
  /** USD per 1M cache-write tokens */
  cacheWrite?: number;
}

export interface ToolStatEntry {
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

export interface ToolStatsResult {
  from: number;
  to: number;
  totalCalls: number;
  tools: ToolStatEntry[];
}

export interface DevtoolsErrorEntry {
  runId: string;
  source: 'tool' | 'llm';
  name: string;
  message: string;
  at: number;
  spanIndex?: number;
  sessionId?: string;
}

export interface ErrorAggregateEntry {
  message: string;
  count: number;
  source: 'tool' | 'llm';
  names: string[];
  lastAt: number;
  sampleRunIds: string[];
}

export interface ErrorsResult {
  from: number;
  to: number;
  total: number;
  entries: DevtoolsErrorEntry[];
  aggregates: ErrorAggregateEntry[];
}

export type TokenStatsGroupBy = 'none' | 'model' | 'session';

export interface DevtoolsIntegrationOptions extends DevtoolsStoreOptions {
  pluginName?: string;
  pluginVersion?: string;
  toolName?: string;
  enableTool?: boolean;
}

export interface DevtoolsIntegration {
  store: DevtoolsStore;
  enginePlugin: EnginePlugin;
  initialize(): Promise<void>;
}

const DEFAULT_FLUSH_DELAY_MS = 200;
const DEFAULT_MAX_INDEX_ENTRIES = 500;
const DEFAULT_PROMPT_SNAPSHOT_LIMIT_BYTES = 256 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer xxx
  [/(authorization|bearer)["'\s:=]+[a-zA-Z0-9._\-]{16,}/gi, '$1: [REDACTED]'],
  // sk-... API keys (OpenAI, Anthropic, etc.)
  [/\bsk-[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_KEY]'],
  // Generic api_key="..." / "apiKey": "..."
  [/((?:api[_-]?key|secret|token|password)["'\s:=]+)([a-zA-Z0-9._\-]{12,})/gi, '$1[REDACTED]'],
  // AWS-like access keys
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS]'],
  // Email addresses
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  // Phone (CN 11 digits & generic +-numbers)
  [/\b1[3-9]\d{9}\b/g, '[REDACTED_PHONE]'],
];

function defaultRedact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const DEFAULT_MODEL_PRICES: Record<string, ModelPriceEntry> = {
  // Anthropic Claude (USD per 1M tokens)
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'o1': { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Google Gemini
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

function resolveModelPrice(
  model: string | undefined,
  prices: Record<string, ModelPriceEntry>,
): ModelPriceEntry | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  if (prices[lower]) return prices[lower];
  // Loose match by prefix (e.g. provider/model:version → strip)
  const stripped = lower.replace(/^[^/]+\//, '').replace(/[:@].*$/, '');
  if (prices[stripped]) return prices[stripped];
  // Find longest matching key prefix
  let best: ModelPriceEntry | undefined;
  let bestLen = 0;
  for (const key of Object.keys(prices)) {
    if (lower.includes(key) && key.length > bestLen) {
      best = prices[key];
      bestLen = key.length;
    }
  }
  return best;
}

function calcCost(
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  price?: ModelPriceEntry,
): number | undefined {
  if (!price) return undefined;
  const usd =
    ((price.input ?? 0) * tokens.inputTokens +
      (price.output ?? 0) * tokens.outputTokens +
      (price.cacheRead ?? 0) * tokens.cacheReadTokens +
      (price.cacheWrite ?? 0) * tokens.cacheWriteTokens) /
    1_000_000;
  return Number.isFinite(usd) && usd > 0 ? Number(usd.toFixed(6)) : undefined;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function now(): number {
  return Date.now();
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return json;
    }
    return String(value);
  } catch {
    return String(value);
  }
}

function buildPreview(value: unknown, limit = 180): string {
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function estimateTokensFromMessages(messages: Array<{ role?: string; content?: any }>): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += (message.role ?? '').length;
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else if (message.content !== undefined) {
      totalChars += safeStringify(message.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

function pickNumber(source: any, keys: string[]): number | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const value = (source as any)[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function pickNumberDeep(source: any, paths: string[][]): number | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  for (const path of paths) {
    let cursor: any = source;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = cursor[key];
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor)) {
      return cursor;
    }
  }
  return undefined;
}

function extractUsageTokens(usage: any): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  if (!usage) {
    return {};
  }

  const inputTokens = pickNumber(usage, [
    'inputTokens',
    'promptTokens',
    'input_tokens',
    'prompt_tokens',
  ]);

  const outputTokens = pickNumber(usage, [
    'outputTokens',
    'completionTokens',
    'output_tokens',
    'completion_tokens',
  ]);

  const cacheReadTokens = pickNumber(usage, [
    'cacheReadInputTokens',
    'cache_read_input_tokens',
    'cache_read_tokens',
    'cachedInputTokens',
  ]) ?? pickNumberDeep(usage, [
    ['inputTokenDetails', 'cacheReadTokens'],
    ['inputTokenDetails', 'cachedTokens'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['promptTokensDetails', 'cachedTokens'],
    ['raw', 'input_tokens_details', 'cached_tokens'],
  ]);

  const cacheWriteTokens = pickNumber(usage, [
    'cacheWriteInputTokens',
    'cache_creation_input_tokens',
    'cache_create_input_tokens',
    'cache_write_tokens',
  ]) ?? pickNumberDeep(usage, [
    ['prompt_tokens_details', 'cache_creation_tokens'],
    ['promptTokensDetails', 'cacheCreationTokens'],
  ]);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export class DevtoolsStore {
  private baseDir: string;
  private runsDir: string;
  private indexPath: string;
  private index: DevtoolsRunSummary[] = [];
  private runs = new Map<string, DevtoolsRunRecord>();
  private initialized = false;
  private flushDelayMs: number;
  private maxEntries: number;
  private saveUserText: boolean;
  private capturePrompts: boolean;
  private promptSnapshotLimitBytes: number;
  private promptRedactor: (text: string) => string;
  private modelPrices: Record<string, ModelPriceEntry>;
  private runFlushTimers = new Map<string, NodeJS.Timeout>();
  private indexFlushTimer: NodeJS.Timeout | null = null;

  constructor(options: DevtoolsStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'devtools');
    this.runsDir = join(this.baseDir, 'runs');
    this.indexPath = join(this.baseDir, 'index.json');
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
    this.saveUserText = options.saveUserText !== false;
    this.capturePrompts = options.capturePrompts !== false;
    this.promptSnapshotLimitBytes = options.promptSnapshotLimitBytes ?? DEFAULT_PROMPT_SNAPSHOT_LIMIT_BYTES;
    this.promptRedactor = options.promptRedactor ?? defaultRedact;
    this.modelPrices = { ...DEFAULT_MODEL_PRICES, ...(options.modelPrices ?? {}) };
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.runs)) {
        this.index = parsed.runs as DevtoolsRunSummary[];
      } else if (Array.isArray(parsed)) {
        this.index = parsed as DevtoolsRunSummary[];
      }
    } catch {
      this.index = [];
    }
    this.initialized = true;
  }

  listRuns(options: DevtoolsRunListOptions = {}): DevtoolsRunSummary[] {
    const limit = Math.min(options.limit ?? 50, this.maxEntries);
    const { status, from, to, sessionId } = options;
    let runs = status ? this.index.filter((item) => item.status === status) : this.index;
    if (from !== undefined) {
      runs = runs.filter((item) => item.startedAt >= from);
    }
    if (to !== undefined) {
      runs = runs.filter((item) => item.startedAt <= to);
    }
    if (sessionId) {
      runs = runs.filter((item) => item.sessionId === sessionId);
    }
    return runs.slice(0, limit);
  }

  async getRun(runId: string): Promise<DevtoolsRunRecord | null> {
    const cached = this.runs.get(runId);
    if (cached) {
      return JSON.parse(JSON.stringify(cached)) as DevtoolsRunRecord;
    }
    try {
      const raw = await fs.readFile(this.runPath(runId), 'utf-8');
      const parsed = JSON.parse(raw) as DevtoolsRunRecord;
      return parsed;
    } catch {
      return null;
    }
  }

  startRun(input: DevtoolsRunCreateInput): void {
    const timestamp = now();
    const rawUserText = input.userText ?? '';
    const userText = this.saveUserText ? rawUserText : '';
    const record: DevtoolsRunRecord = {
      runId: input.runId,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      lastEventAt: timestamp,
      pluginName: input.pluginName,
      pluginVersion: input.pluginVersion,
      sessionId: input.sessionId,
      platformKey: input.platformKey,
      caller: input.caller,
      callerSelectors: input.callerSelectors,
      userText: this.saveUserText ? userText : undefined,
      userTextPreview: this.saveUserText ? buildPreview(userText) : undefined,
      llmCalls: 0,
      toolCalls: 0,
      compactions: 0,
      llmSpans: [],
      toolSpans: [],
      compactionEvents: [],
      pluginHooks: [],
    };

    this.runs.set(input.runId, record);
    this.upsertSummary(record);
    this.scheduleRunFlush(input.runId);
    this.scheduleIndexFlush();
  }

  finishRun(runId: string, resultText?: string): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.status = 'finished';
    record.endedAt = timestamp;
    record.durationMs = Math.max(0, timestamp - record.startedAt);
    record.updatedAt = timestamp;
    record.lastEventAt = timestamp;
    if (resultText) {
      record.resultTextPreview = buildPreview(resultText, 220);
    }
    this.upsertSummary(record);
    this.scheduleRunFlush(runId);
    this.scheduleIndexFlush();
  }

  recordLLMStart(
    runId: string,
    inputTokens?: number,
    snapshot?: {
      messages?: any[];
      systemPrompt?: string;
      model?: string;
      toolNames?: string[];
    },
  ): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.llmCalls += 1;
    const span: DevtoolsLlmSpan = {
      index: record.llmCalls,
      startedAt: timestamp,
      inputTokens,
    };
    if (snapshot?.model) {
      span.model = snapshot.model;
    }
    if (snapshot?.toolNames?.length) {
      span.toolNames = snapshot.toolNames.slice(0, 100);
    }
    if (snapshot?.messages) {
      span.messageCount = snapshot.messages.length;
    }
    if (snapshot?.systemPrompt) {
      span.systemPromptPreview = buildPreview(this.promptRedactor(snapshot.systemPrompt), 240);
    }
    record.llmSpans.push(span);

    // Async snapshot persistence (best-effort, non-blocking).
    if (this.capturePrompts && snapshot && (snapshot.messages?.length || snapshot.systemPrompt)) {
      void this.savePromptSnapshot(record.runId, span, snapshot).catch(() => {
        /* swallow snapshot errors */
      });
    }

    this.touch(record, timestamp);
  }

  private async savePromptSnapshot(
    runId: string,
    span: DevtoolsLlmSpan,
    snapshot: { messages?: any[]; systemPrompt?: string; model?: string; toolNames?: string[] },
  ): Promise<void> {
    const limit = this.promptSnapshotLimitBytes;
    const redactedSystem = snapshot.systemPrompt ? this.promptRedactor(snapshot.systemPrompt) : undefined;
    const sysTruncated = redactedSystem !== undefined && redactedSystem.length > limit;
    const sysOut = sysTruncated ? `${redactedSystem!.slice(0, limit)}…[truncated]` : redactedSystem;

    // Pre-compute redacted serializations for all messages so we can do
    // head+tail windowing when the total exceeds the byte limit.
    const allMsgs = snapshot.messages ?? [];
    const redacted: string[] = allMsgs.map((m) => this.promptRedactor(safeStringify(m)));
    const totalMsgBytes = redacted.reduce((s, r) => s + r.length, 0);

    const messages: any[] = [];
    let usedBytes = 0;
    let messagesTruncated = false;

    const parseMsg = (raw: string, fallback: any): any => {
      try { return JSON.parse(raw); } catch { return { role: 'unknown', content: raw }; }
    };

    if (totalMsgBytes <= limit) {
      // Fits entirely — no truncation needed.
      for (let i = 0; i < allMsgs.length; i++) {
        messages.push(parseMsg(redacted[i], allMsgs[i]));
        usedBytes += redacted[i].length;
      }
    } else {
      // Head+tail strategy: reserve half the budget for the tail (newest messages)
      // so Cache Diff can always see what's new.
      messagesTruncated = true;
      const tailBudget = Math.floor(limit * 0.4);
      const headBudget = limit - tailBudget;

      // --- head: fill from the front ---
      const headMsgs: any[] = [];
      let headBytes = 0;
      for (let i = 0; i < allMsgs.length; i++) {
        if (headBytes + redacted[i].length > headBudget) break;
        headMsgs.push(parseMsg(redacted[i], allMsgs[i]));
        headBytes += redacted[i].length;
      }

      // --- tail: fill from the back ---
      const tailMsgs: any[] = [];
      let tailBytes = 0;
      for (let i = allMsgs.length - 1; i >= headMsgs.length; i--) {
        if (tailBytes + redacted[i].length > tailBudget) break;
        tailMsgs.unshift(parseMsg(redacted[i], allMsgs[i]));
        tailBytes += redacted[i].length;
      }

      const skipped = allMsgs.length - headMsgs.length - tailMsgs.length;
      messages.push(...headMsgs);
      if (skipped > 0) {
        messages.push({ role: '__gap__', content: `…[${skipped} messages skipped]`, _skipped: skipped });
      }
      messages.push(...tailMsgs);
      usedBytes = headBytes + tailBytes;
    }

    const totalBytes = usedBytes + (sysOut?.length ?? 0);
    const skippedMessages = messagesTruncated
      ? messages.filter((m) => m.role === '__gap__').reduce((s, m) => s + (m._skipped ?? 0), 0)
      : 0;
    const snap: DevtoolsLlmPromptSnapshot = {
      runId,
      spanIndex: span.index,
      capturedAt: now(),
      model: snapshot.model,
      systemPrompt: sysOut,
      systemPromptTruncated: sysTruncated,
      messages,
      messagesTruncated,
      totalMessageCount: allMsgs.length,
      skippedMessages: skippedMessages > 0 ? skippedMessages : undefined,
      toolNames: snapshot.toolNames,
      totalBytes,
    };

    const dir = join(this.runsDir, runId, 'llm');
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${span.index}.json`);
    await fs.writeFile(file, JSON.stringify(snap, null, 2), 'utf-8');

    span.promptRef = `runs/${runId}/llm/${span.index}.json`;
    span.messagesBytes = totalBytes;
    span.promptTruncated = messagesTruncated || sysTruncated;
    this.scheduleRunFlush(runId);
  }

  async getLlmPromptSnapshot(runId: string, spanIndex: number): Promise<DevtoolsLlmPromptSnapshot | null> {
    const file = join(this.runsDir, runId, 'llm', `${spanIndex}.json`);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      return JSON.parse(raw) as DevtoolsLlmPromptSnapshot;
    } catch {
      return null;
    }
  }

  recordLLMEnd(
    runId: string,
    finishReason?: string,
    text?: string,
    usage?: any,
    timings?: { firstChunkAt?: number; lastChunkAt?: number; requestStartAt?: number; firstTextAt?: number },
    extras?: { model?: string },
  ): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    const span = [...record.llmSpans].reverse().find((item) => item.endedAt === undefined);
    if (!span) {
      return;
    }
    span.endedAt = timestamp;
    span.durationMs = Math.max(0, timestamp - span.startedAt);
    if (timings?.requestStartAt && Number.isFinite(timings.requestStartAt)) {
      span.requestStartAt = timings.requestStartAt;
      span.enginePrepMs = Math.max(0, timings.requestStartAt - span.startedAt);
    }
    if (timings?.firstChunkAt && Number.isFinite(timings.firstChunkAt)) {
      span.firstChunkAt = timings.firstChunkAt;
      span.ttfbMs = Math.max(0, timings.firstChunkAt - (timings.requestStartAt ?? span.startedAt));
      span.ttftMs = Math.max(0, timings.firstChunkAt - span.startedAt);
      span.streamDurationMs = Math.max(0, timestamp - timings.firstChunkAt);
    }
    if (timings?.firstTextAt && Number.isFinite(timings.firstTextAt)) {
      span.firstTextAt = timings.firstTextAt;
      span.ttftTextMs = Math.max(0, timings.firstTextAt - (timings.requestStartAt ?? span.startedAt));
    }
    span.finishReason = finishReason;
    if (extras?.model && !span.model) {
      span.model = extras.model;
    }
    span.textLength = typeof text === 'string' ? text.length : undefined;
    if (usage !== undefined) {
      const rawUsage = safeStringify(usage);
      const limit = 4000;
      if (rawUsage.length > limit) {
        span.usageRaw = `${rawUsage.slice(0, limit)}...`;
        span.usageTruncated = true;
      } else {
        span.usageRaw = rawUsage;
        span.usageTruncated = false;
      }
    }
    const usageTokens = extractUsageTokens(usage);
    if (usageTokens.inputTokens !== undefined) {
      span.inputTokens = usageTokens.inputTokens;
    }
    if (usageTokens.outputTokens !== undefined) {
      span.outputTokens = usageTokens.outputTokens;
    } else if (typeof text === 'string') {
      span.outputTokens = estimateTokensFromText(text);
    }
    if (usageTokens.cacheReadTokens !== undefined) {
      span.cacheReadTokens = usageTokens.cacheReadTokens;
    }
    if (usageTokens.cacheWriteTokens !== undefined) {
      span.cacheWriteTokens = usageTokens.cacheWriteTokens;
    }
    this.touch(record, timestamp);
  }

  recordLLMError(runId: string, error: Error | string, model?: string): void {
    const record = this.runs.get(runId);
    if (!record) return;
    const timestamp = now();
    const span = [...record.llmSpans].reverse().find((item) => item.endedAt === undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (span) {
      span.endedAt = timestamp;
      span.durationMs = Math.max(0, timestamp - span.startedAt);
      span.errorMessage = message;
      if (model && !span.model) {
        span.model = model;
      }
    }
    this.touch(record, timestamp);
  }

  recordPluginHook(runId: string, hook: DevtoolsPluginHookSpan): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    record.pluginHooks.push(hook);
    this.touch(record);
  }

  recordToolCall(runId: string, name: string, input: unknown): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const span = [...record.llmSpans].reverse().find((item) => item.endedAt === undefined) ?? record.llmSpans.at(-1);
    if (!span) {
      return;
    }
    if (!span.toolCalls) {
      span.toolCalls = [];
    }
    span.toolCalls.push({
      name,
      inputSize: safeStringify(input).length,
      inputPreview: buildPreview(input, 140),
    });
    this.touch(record);
  }

  recordToolStart(runId: string, name: string, input: unknown): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.toolCalls += 1;
    record.toolSpans.push({
      index: record.toolCalls,
      name,
      startedAt: timestamp,
      inputSize: safeStringify(input).length,
      inputPreview: buildPreview(input, 160),
    });
    this.touch(record, timestamp);
  }

  recordToolEnd(runId: string, name: string, output: unknown, error?: Error): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    const span = [...record.toolSpans].reverse().find((item) => item.name === name && item.endedAt === undefined);
    if (!span) {
      return;
    }
    span.endedAt = timestamp;
    span.durationMs = Math.max(0, timestamp - span.startedAt);
    span.outputSize = safeStringify(output).length;
    span.outputPreview = buildPreview(output, 160);
    if (error) {
      span.error = error.message;
    }
    this.touch(record, timestamp);
  }

  recordCompaction(runId: string, event: OnCompactedEvent): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.compactions += 1;
    record.compactionEvents.push({
      at: timestamp,
      attempt: event.attempt,
      trigger: event.trigger,
      reason: event.reason,
      forced: event.forced,
      beforeMessageCount: event.beforeMessageCount,
      afterMessageCount: event.afterMessageCount,
      beforeEstimatedTokens: event.beforeEstimatedTokens,
      afterEstimatedTokens: event.afterEstimatedTokens,
      strategy: event.strategy,
    });
    this.touch(record, timestamp);
  }

  updateRun(runId: string, update: DevtoolsRunUpdate): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    Object.assign(record, update);
    record.updatedAt = update.endedAt ?? now();
    record.lastEventAt = record.updatedAt;
    this.upsertSummary(record);
    this.scheduleRunFlush(runId);
    this.scheduleIndexFlush();
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private touch(record: DevtoolsRunRecord, timestamp = now()): void {
    record.updatedAt = timestamp;
    record.lastEventAt = timestamp;
    this.upsertSummary(record);
    this.scheduleRunFlush(record.runId);
    this.scheduleIndexFlush();
  }

  private upsertSummary(record: DevtoolsRunRecord): void {
    const totalInputTokens = record.llmSpans.reduce((s, x) => s + (x.inputTokens ?? 0), 0);
    const totalOutputTokens = record.llmSpans.reduce((s, x) => s + (x.outputTokens ?? 0), 0);
    const totalCacheReadTokens = record.llmSpans.reduce((s, x) => s + (x.cacheReadTokens ?? 0), 0);
    const totalCacheWriteTokens = record.llmSpans.reduce((s, x) => s + (x.cacheWriteTokens ?? 0), 0);

    const modelSet = new Set<string>();
    let costUsd = 0;
    let hasCost = false;
    for (const span of record.llmSpans) {
      if (span.model) modelSet.add(span.model);
      const price = resolveModelPrice(span.model, this.modelPrices);
      const c = calcCost(
        {
          inputTokens: span.inputTokens ?? 0,
          outputTokens: span.outputTokens ?? 0,
          cacheReadTokens: span.cacheReadTokens ?? 0,
          cacheWriteTokens: span.cacheWriteTokens ?? 0,
        },
        price,
      );
      if (c !== undefined) {
        costUsd += c;
        hasCost = true;
      }
    }

    const toolErrorCount = record.toolSpans.filter((s) => s.error).length;
    const llmErrorCount = record.llmSpans.filter((s) => s.errorMessage).length;
    const errorCount = toolErrorCount + llmErrorCount;

    const summary: DevtoolsRunSummary = {
      runId: record.runId,
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      lastEventAt: record.lastEventAt,
      durationMs: record.durationMs,
      pluginName: record.pluginName,
      pluginVersion: record.pluginVersion,
      sessionId: record.sessionId,
      platformKey: record.platformKey,
      caller: record.caller,
      userTextPreview: record.userTextPreview,
      llmCalls: record.llmCalls,
      toolCalls: record.toolCalls,
      compactions: record.compactions,
      totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      totalCacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
      totalCacheWriteTokens: totalCacheWriteTokens > 0 ? totalCacheWriteTokens : undefined,
      models: modelSet.size > 0 ? [...modelSet] : undefined,
      errorCount: errorCount > 0 ? errorCount : undefined,
      costUsd: hasCost ? Number(costUsd.toFixed(6)) : undefined,
    };

    const existingIndex = this.index.findIndex((item) => item.runId === record.runId);
    if (existingIndex >= 0) {
      this.index[existingIndex] = summary;
    } else {
      this.index.unshift(summary);
    }

    if (this.index.length > this.maxEntries) {
      this.index.length = this.maxEntries;
    }
  }

  private scheduleRunFlush(runId: string): void {
    if (!this.initialized) {
      return;
    }
    if (this.runFlushTimers.has(runId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.runFlushTimers.delete(runId);
      void this.flushRun(runId);
    }, this.flushDelayMs);
    this.runFlushTimers.set(runId, timer);
  }

  private scheduleIndexFlush(): void {
    if (!this.initialized) {
      return;
    }
    if (this.indexFlushTimer) {
      return;
    }
    this.indexFlushTimer = setTimeout(() => {
      this.indexFlushTimer = null;
      void this.flushIndex();
    }, this.flushDelayMs);
  }

  private async flushRun(runId: string): Promise<void> {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    await fs.writeFile(this.runPath(runId), JSON.stringify(record, null, 2), 'utf-8');
  }

  private async flushIndex(): Promise<void> {
    await fs.writeFile(
      this.indexPath,
      JSON.stringify({ updatedAt: now(), runs: this.index }, null, 2),
      'utf-8',
    );
  }

  getTokenStats(options: TokenStatsOptions): TokenStatsResult {
    const { from, to, granularity = 'day', sessionId, groupBy = 'none' } = options;

    // Filter runs within the time range
    let runs = this.index.filter((r) => r.startedAt >= from && r.startedAt <= to);
    if (sessionId) {
      runs = runs.filter((r) => r.sessionId === sessionId);
    }

    // Build bucket boundaries
    const bucketMap = new Map<number, TokenStatsBucket>();

    const getBucketTs = (ts: number): number => {
      const d = new Date(ts);
      if (granularity === 'hour') {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
      }
      if (granularity === 'week') {
        const day = d.getDay(); // 0=Sun
        const diff = day === 0 ? -6 : 1 - day; // align to Monday
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
        return monday.getTime();
      }
      // default: day
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };

    const formatBucketLabel = (ts: number): string => {
      const d = new Date(ts);
      if (granularity === 'hour') {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd} ${hh}:00`;
      }
      if (granularity === 'week') {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
      }
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-${dd}`;
    };

    // Pre-fill all bucket slots so gaps show as zero
    let cursor = getBucketTs(from);
    const endTs = getBucketTs(to);
    while (cursor <= endTs) {
      bucketMap.set(cursor, {
        ts: cursor,
        label: formatBucketLabel(cursor),
        runCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      });
      // Advance by granularity
      if (granularity === 'hour') {
        cursor += 60 * 60 * 1000;
      } else if (granularity === 'week') {
        cursor += 7 * 24 * 60 * 60 * 1000;
      } else {
        cursor += 24 * 60 * 60 * 1000;
      }
    }

    // Accumulate per run into buckets
    const summary: TokenStatsSummary = {
      totalRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };

    const groupMap = new Map<string, TokenStatsGroupEntry>();
    let hasCost = false;

    for (const run of runs) {
      const bucketTs = getBucketTs(run.startedAt);
      let bucket = bucketMap.get(bucketTs);
      if (!bucket) {
        bucket = {
          ts: bucketTs,
          label: formatBucketLabel(bucketTs),
          runCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        };
        bucketMap.set(bucketTs, bucket);
      }
      const inp = run.totalInputTokens ?? 0;
      const out = run.totalOutputTokens ?? 0;
      const cr = run.totalCacheReadTokens ?? 0;
      const cw = run.totalCacheWriteTokens ?? 0;
      const total = inp + out;
      const cost = run.costUsd ?? 0;
      if (run.costUsd !== undefined) hasCost = true;

      bucket.runCount += 1;
      bucket.inputTokens += inp;
      bucket.outputTokens += out;
      bucket.cacheReadTokens += cr;
      bucket.cacheWriteTokens += cw;
      bucket.totalTokens += total;
      bucket.costUsd = (bucket.costUsd ?? 0) + cost;

      summary.totalRuns += 1;
      summary.inputTokens += inp;
      summary.outputTokens += out;
      summary.cacheReadTokens += cr;
      summary.cacheWriteTokens += cw;
      summary.totalTokens += total;
      summary.costUsd = (summary.costUsd ?? 0) + cost;

      if (groupBy !== 'none') {
        const key =
          groupBy === 'session'
            ? run.sessionId ?? 'unknown'
            : run.models?.[0] ?? 'unknown';
        let entry = groupMap.get(key);
        if (!entry) {
          entry = {
            key,
            runCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          };
          groupMap.set(key, entry);
        }
        entry.runCount += 1;
        entry.inputTokens += inp;
        entry.outputTokens += out;
        entry.cacheReadTokens += cr;
        entry.cacheWriteTokens += cw;
        entry.totalTokens += total;
        entry.costUsd = (entry.costUsd ?? 0) + cost;
      }
    }

    if (!hasCost) {
      summary.costUsd = undefined;
      for (const b of bucketMap.values()) b.costUsd = undefined;
      for (const g of groupMap.values()) g.costUsd = undefined;
    } else if (summary.costUsd !== undefined) {
      summary.costUsd = Number(summary.costUsd.toFixed(6));
      for (const b of bucketMap.values()) {
        if (b.costUsd !== undefined) b.costUsd = Number(b.costUsd.toFixed(6));
      }
      for (const g of groupMap.values()) {
        if (g.costUsd !== undefined) g.costUsd = Number(g.costUsd.toFixed(6));
      }
    }

    const buckets = [...bucketMap.values()].sort((a, b) => a.ts - b.ts);
    const groups =
      groupBy === 'none'
        ? undefined
        : [...groupMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

    return { summary, buckets, groups };
  }

  /**
   * Aggregate tool span metrics across runs in [from, to].
   * Reads run records from disk for runs not in cache.
   */
  async getToolStats(options: { from: number; to: number; sessionId?: string }): Promise<ToolStatsResult> {
    const { from, to, sessionId } = options;
    let runs = this.index.filter((r) => r.startedAt >= from && r.startedAt <= to);
    if (sessionId) runs = runs.filter((r) => r.sessionId === sessionId);

    type Acc = {
      durations: number[];
      errorCount: number;
      inputBytes: number;
      outputBytes: number;
      lastUsedAt: number;
    };
    const map = new Map<string, Acc>();
    let totalCalls = 0;

    for (const summary of runs) {
      // Skip runs with no tool calls fast.
      if (!summary.toolCalls) continue;
      const record = await this.getRun(summary.runId);
      if (!record) continue;
      for (const span of record.toolSpans) {
        if (!span.endedAt) continue;
        let acc = map.get(span.name);
        if (!acc) {
          acc = { durations: [], errorCount: 0, inputBytes: 0, outputBytes: 0, lastUsedAt: 0 };
          map.set(span.name, acc);
        }
        acc.durations.push(span.durationMs ?? 0);
        if (span.error) acc.errorCount += 1;
        acc.inputBytes += span.inputSize ?? 0;
        acc.outputBytes += span.outputSize ?? 0;
        if ((span.endedAt ?? 0) > acc.lastUsedAt) acc.lastUsedAt = span.endedAt ?? 0;
        totalCalls += 1;
      }
    }

    const tools: ToolStatEntry[] = [...map.entries()]
      .map(([name, acc]) => {
        const count = acc.durations.length;
        const total = acc.durations.reduce((s, x) => s + x, 0);
        return {
          name,
          count,
          errorCount: acc.errorCount,
          errorRate: count > 0 ? Number((acc.errorCount / count).toFixed(4)) : 0,
          totalDurationMs: total,
          avgDurationMs: count > 0 ? Math.round(total / count) : 0,
          p50DurationMs: percentile(acc.durations, 50),
          p95DurationMs: percentile(acc.durations, 95),
          maxDurationMs: acc.durations.length ? Math.max(...acc.durations) : 0,
          avgInputBytes: count > 0 ? Math.round(acc.inputBytes / count) : 0,
          avgOutputBytes: count > 0 ? Math.round(acc.outputBytes / count) : 0,
          lastUsedAt: acc.lastUsedAt,
        };
      })
      .sort((a, b) => b.count - a.count);

    return { from, to, totalCalls, tools };
  }

  /**
   * Aggregate errors (tool + LLM) across runs in [from, to].
   */
  async getErrors(options: {
    from: number;
    to: number;
    sessionId?: string;
    limit?: number;
  }): Promise<ErrorsResult> {
    const { from, to, sessionId, limit = 200 } = options;
    let runs = this.index.filter((r) => r.startedAt >= from && r.startedAt <= to);
    if (sessionId) runs = runs.filter((r) => r.sessionId === sessionId);

    const entries: DevtoolsErrorEntry[] = [];
    for (const summary of runs) {
      if (!summary.errorCount) continue;
      const record = await this.getRun(summary.runId);
      if (!record) continue;
      for (const span of record.toolSpans) {
        if (!span.error) continue;
        entries.push({
          runId: record.runId,
          source: 'tool',
          name: span.name,
          message: span.error,
          at: span.endedAt ?? span.startedAt,
          spanIndex: span.index,
          sessionId: record.sessionId,
        });
      }
      for (const span of record.llmSpans) {
        if (!span.errorMessage) continue;
        entries.push({
          runId: record.runId,
          source: 'llm',
          name: span.model ?? 'llm',
          message: span.errorMessage,
          at: span.endedAt ?? span.startedAt,
          spanIndex: span.index,
          sessionId: record.sessionId,
        });
      }
    }

    entries.sort((a, b) => b.at - a.at);
    const trimmed = entries.slice(0, limit);

    const aggMap = new Map<string, ErrorAggregateEntry>();
    for (const entry of entries) {
      // Normalize message: strip numbers / hashes / paths to merge similar errors.
      const normalized = entry.message
        .replace(/\d+/g, 'N')
        .replace(/0x[0-9a-fA-F]+/g, 'HEX')
        .replace(/\/[\w\-./]+/g, '/PATH')
        .slice(0, 200);
      const key = `${entry.source}:${normalized}`;
      let agg = aggMap.get(key);
      if (!agg) {
        agg = {
          message: normalized,
          count: 0,
          source: entry.source,
          names: [],
          lastAt: 0,
          sampleRunIds: [],
        };
        aggMap.set(key, agg);
      }
      agg.count += 1;
      if (!agg.names.includes(entry.name)) agg.names.push(entry.name);
      if (entry.at > agg.lastAt) agg.lastAt = entry.at;
      if (agg.sampleRunIds.length < 5 && !agg.sampleRunIds.includes(entry.runId)) {
        agg.sampleRunIds.push(entry.runId);
      }
    }

    const aggregates = [...aggMap.values()].sort((a, b) => b.count - a.count);

    return { from, to, total: entries.length, entries: trimmed, aggregates };
  }
}

const runIdByContext = new WeakMap<Context, string>();
const DEVTOOLS_WRAPPED = Symbol('devtoolsWrapped');

function wrapTool(name: string, tool: Tool, store: DevtoolsStore): Tool {
  if ((tool as any)[DEVTOOLS_WRAPPED]) {
    return tool;
  }

  const wrapped: Tool = {
    ...tool,
    execute: async (input: any, context?: ToolExecutionContext) => {
      const runId = context?.runContext?.runId;
      if (runId) {
        store.recordToolStart(runId, name, input);
      }
      try {
        const output = await tool.execute.call(tool, input, context);
        if (runId) {
          store.recordToolEnd(runId, name, output);
        }
        return output;
      } catch (error) {
        if (runId) {
          store.recordToolEnd(runId, name, undefined, error as Error);
        }
        throw error;
      }
    },
  };

  (wrapped as any)[DEVTOOLS_WRAPPED] = true;
  return wrapped;
}

function wrapTools(tools: Record<string, Tool>, store: DevtoolsStore): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = wrapTool(name, tool, store);
  }
  return wrapped;
}

function resolveRunId(input: { runContext?: Record<string, any> }): string {
  const existing = input.runContext?.runId;
  if (existing) {
    return String(existing);
  }
  const generated = randomUUID();
  if (input.runContext) {
    input.runContext.runId = generated;
  }
  return generated;
}

function extractRunMeta(runId: string, runContext?: Record<string, any>, saveUserText: boolean = true): DevtoolsRunCreateInput {
  return {
    runId,
    sessionId: typeof runContext?.sessionId === 'string' ? runContext.sessionId : undefined,
    platformKey: typeof runContext?.platformKey === 'string' ? runContext.platformKey : undefined,
    caller: typeof runContext?.caller === 'string' ? runContext.caller : undefined,
    callerSelectors: Array.isArray(runContext?.callerSelectors) ? runContext?.callerSelectors : undefined,
    userText: saveUserText && typeof runContext?.userText === 'string' ? runContext.userText : undefined,
  };
}

function createRunGetTool(store: DevtoolsStore, name: string): Tool {
  const schema = z.object({
    runId: z.string().min(1).describe('Run ID to fetch'),
    includeUserText: z.boolean().optional().describe('Whether to include raw userText field'),
  });

  return {
    name,
    description: 'Fetch devtools run details by runId for diagnostics.',
    defer_loading: true,
    inputSchema: schema,
    execute: async (input: { runId: string; includeUserText?: boolean }) => {
      const run = await store.getRun(input.runId);
      if (!run) {
        return { ok: false, error: 'Run not found' };
      }
      if (input.includeUserText === false) {
        const copy = { ...run };
        delete (copy as DevtoolsRunRecord).userText;
        return { ok: true, run: copy };
      }
      return { ok: true, run };
    },
  };
}

export function createDevtoolsIntegration(options: DevtoolsIntegrationOptions = {}): DevtoolsIntegration {
  const store = new DevtoolsStore(options);
  const toolName = options.toolName ?? 'devtools_run_get';
  const enableTool = options.enableTool !== false;

  const enginePlugin: EnginePlugin = {
    name: options.pluginName ?? 'devtools',
    version: options.pluginVersion ?? '0.1.0',
    async initialize(context) {
      context.registerService('devtoolsStore', store);

      if (enableTool) {
        context.registerTool(toolName, createRunGetTool(store, toolName));
      }

      context.registerHook('beforeRun', (input) => {
        const runId = resolveRunId(input);
        runIdByContext.set(input.context, runId);
        const meta = extractRunMeta(runId, input.runContext, options.saveUserText !== false);
        meta.pluginName = options.pluginName ?? 'devtools';
        meta.pluginVersion = options.pluginVersion ?? '0.1.0';
        store.startRun(meta);
        return { tools: wrapTools(input.tools, store) };
      });

      context.registerHook('beforeLLMCall', (input) => {
        const runId = runIdByContext.get(input.context);
        if (runId) {
          const messages = input.context?.messages ?? [];
          const messageTokens = estimateTokensFromMessages(messages);
          let systemPromptText: string | undefined;
          if (typeof input.systemPrompt === 'string') {
            systemPromptText = input.systemPrompt;
          } else if (typeof input.systemPrompt === 'function') {
            try {
              systemPromptText = input.systemPrompt();
            } catch {
              systemPromptText = undefined;
            }
          } else if (input.systemPrompt && typeof (input.systemPrompt as any).append === 'string') {
            systemPromptText = (input.systemPrompt as any).append;
          }
          const systemPromptTokens = systemPromptText ? estimateTokensFromText(systemPromptText) : 0;
          const inputTokens = messageTokens + systemPromptTokens;
          const toolNames = Object.keys(input.tools ?? {});
          const model =
            (input.runContext as any)?.model ??
            (input.context as any)?.model ??
            undefined;
          store.recordLLMStart(runId, inputTokens, {
            messages,
            systemPrompt: systemPromptText,
            model: typeof model === 'string' ? model : undefined,
            toolNames,
          });
        }
        return { tools: wrapTools(input.tools, store) };
      });

      context.registerHook('afterLLMCall', (input) => {
        const runId = runIdByContext.get(input.context);
        if (runId) {
          const model =
            (input as any).model ??
            (input.context as any)?.model ??
            undefined;
          store.recordLLMEnd(
            runId,
            input.finishReason,
            input.text,
            input.usage,
            input.timings,
            { model: typeof model === 'string' ? model : undefined },
          );
        }
      });

      context.registerHook('onToolCall', (input) => {
        const runId = runIdByContext.get(input.context);
        if (!runId) {
          return;
        }
        const toolCall = input.toolCall ?? {};
        const name = toolCall?.toolName ?? toolCall?.name ?? 'unknown';
        const args = toolCall?.args ?? toolCall?.input ?? {};
        store.recordToolCall(runId, name, args);
      });

      context.registerHook('onCompacted', (input) => {
        const runId = runIdByContext.get(input.context);
        if (runId) {
          store.recordCompaction(runId, input.event);
        }
      });

      context.registerHook('afterRun', (input) => {
        const runId = runIdByContext.get(input.context);
        if (runId) {
          store.finishRun(runId, input.result);
          runIdByContext.delete(input.context);
        }
      });

      context.events.on('hookTiming', (payload: any) => {
        const runId = payload?.context ? runIdByContext.get(payload.context) : undefined;
        if (!runId) {
          return;
        }
        store.recordPluginHook(runId, {
          pluginName: String(payload.pluginName ?? 'unknown'),
          hookName: String(payload.hookName ?? 'unknown'),
          startedAt: Number(payload.at ?? now()),
          durationMs: Number(payload.durationMs ?? 0),
        });
      });
    },
  };

  return {
    store,
    enginePlugin,
    initialize: () => store.initialize(),
  };
}

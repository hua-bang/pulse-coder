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
}

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
  private runFlushTimers = new Map<string, NodeJS.Timeout>();
  private indexFlushTimer: NodeJS.Timeout | null = null;

  constructor(options: DevtoolsStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'devtools');
    this.runsDir = join(this.baseDir, 'runs');
    this.indexPath = join(this.baseDir, 'index.json');
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
    this.saveUserText = options.saveUserText !== false;
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
    const status = options.status;
    const runs = status ? this.index.filter((item) => item.status === status) : this.index;
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

  recordLLMStart(runId: string, inputTokens?: number): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.llmCalls += 1;
    record.llmSpans.push({
      index: record.llmCalls,
      startedAt: timestamp,
      inputTokens,
    });
    this.touch(record, timestamp);
  }

  recordLLMEnd(
    runId: string,
    finishReason?: string,
    text?: string,
    usage?: any,
    timings?: { firstChunkAt?: number; lastChunkAt?: number },
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
          const messageTokens = estimateTokensFromMessages(input.context?.messages ?? []);
          let systemPromptTokens = 0;
          if (typeof input.systemPrompt === 'string') {
            systemPromptTokens = estimateTokensFromText(input.systemPrompt);
          } else if (typeof input.systemPrompt === 'function') {
            try {
              systemPromptTokens = estimateTokensFromText(input.systemPrompt());
            } catch {
              systemPromptTokens = 0;
            }
          } else if (input.systemPrompt && typeof input.systemPrompt.append === 'string') {
            systemPromptTokens = estimateTokensFromText(input.systemPrompt.append);
          }
          const inputTokens = messageTokens + systemPromptTokens;
          store.recordLLMStart(runId, inputTokens);
        }
        return { tools: wrapTools(input.tools, store) };
      });

      context.registerHook('afterLLMCall', (input) => {
        const runId = runIdByContext.get(input.context);
        if (runId) {
          store.recordLLMEnd(runId, input.finishReason, input.text, input.usage, input.timings);
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

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Context, EnginePlugin, OnCompactedEvent, Tool, ToolExecutionContext } from 'pulse-coder-engine';

type RunStatus = 'running' | 'finished';

export interface DevtoolsRunSummary {
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

export interface DevtoolsLlmSpan {
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
  resultTextPreview?: string;
}

interface DevtoolsRunCreateInput {
  runId: string;
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

const DEFAULT_FLUSH_DELAY_MS = 200;
const MAX_INDEX_ENTRIES = 500;

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

class DevtoolsStore {
  private baseDir = join(homedir(), '.pulse-coder', 'devtools');
  private runsDir = join(this.baseDir, 'runs');
  private indexPath = join(this.baseDir, 'index.json');
  private index: DevtoolsRunSummary[] = [];
  private runs = new Map<string, DevtoolsRunRecord>();
  private initialized = false;
  private flushDelayMs = DEFAULT_FLUSH_DELAY_MS;
  private runFlushTimers = new Map<string, NodeJS.Timeout>();
  private indexFlushTimer: NodeJS.Timeout | null = null;

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
    const limit = Math.min(options.limit ?? 50, MAX_INDEX_ENTRIES);
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
    const userText = input.userText ?? '';
    const record: DevtoolsRunRecord = {
      runId: input.runId,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      lastEventAt: timestamp,
      sessionId: input.sessionId,
      platformKey: input.platformKey,
      caller: input.caller,
      callerSelectors: input.callerSelectors,
      userText,
      userTextPreview: buildPreview(userText),
      llmCalls: 0,
      toolCalls: 0,
      compactions: 0,
      llmSpans: [],
      toolSpans: [],
      compactionEvents: [],
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

  recordLLMStart(runId: string): void {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    const timestamp = now();
    record.llmCalls += 1;
    record.llmSpans.push({
      index: record.llmCalls,
      startedAt: timestamp,
    });
    this.touch(record, timestamp);
  }

  recordLLMEnd(runId: string, finishReason?: string, text?: string): void {
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
    span.finishReason = finishReason;
    span.textLength = typeof text === 'string' ? text.length : undefined;
    this.touch(record, timestamp);
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

    if (this.index.length > MAX_INDEX_ENTRIES) {
      this.index.length = MAX_INDEX_ENTRIES;
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

export const devtoolsStore = new DevtoolsStore();

const runIdByContext = new WeakMap<Context, string>();
const DEVTOOLS_WRAPPED = Symbol('devtoolsWrapped');

function wrapTool(name: string, tool: Tool): Tool {
  if ((tool as any)[DEVTOOLS_WRAPPED]) {
    return tool;
  }

  const wrapped: Tool = {
    ...tool,
    execute: async (input: any, context?: ToolExecutionContext) => {
      const runId = context?.runContext?.runId;
      if (runId) {
        devtoolsStore.recordToolStart(runId, name, input);
      }
      try {
        const output = await tool.execute.call(tool, input, context);
        if (runId) {
          devtoolsStore.recordToolEnd(runId, name, output);
        }
        return output;
      } catch (error) {
        if (runId) {
          devtoolsStore.recordToolEnd(runId, name, undefined, error as Error);
        }
        throw error;
      }
    },
  };

  (wrapped as any)[DEVTOOLS_WRAPPED] = true;
  return wrapped;
}

function wrapTools(tools: Record<string, Tool>): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = wrapTool(name, tool);
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

function extractRunMeta(runId: string, runContext?: Record<string, any>): DevtoolsRunCreateInput {
  return {
    runId,
    sessionId: typeof runContext?.sessionId === 'string' ? runContext.sessionId : undefined,
    platformKey: typeof runContext?.platformKey === 'string' ? runContext.platformKey : undefined,
    caller: typeof runContext?.caller === 'string' ? runContext.caller : undefined,
    callerSelectors: Array.isArray(runContext?.callerSelectors) ? runContext?.callerSelectors : undefined,
    userText: typeof runContext?.userText === 'string' ? runContext.userText : undefined,
  };
}

export const devtoolsPlugin: EnginePlugin = {
  name: 'devtools',
  version: '0.1.0',
  async initialize(context) {
    context.registerService('devtoolsStore', devtoolsStore);

    context.registerHook('beforeRun', (input) => {
      const runId = resolveRunId(input);
      runIdByContext.set(input.context, runId);
      devtoolsStore.startRun(extractRunMeta(runId, input.runContext));
      return { tools: wrapTools(input.tools) };
    });

    context.registerHook('beforeLLMCall', (input) => {
      const runId = runIdByContext.get(input.context);
      if (runId) {
        devtoolsStore.recordLLMStart(runId);
      }
      return { tools: wrapTools(input.tools) };
    });

    context.registerHook('afterLLMCall', (input) => {
      const runId = runIdByContext.get(input.context);
      if (runId) {
        devtoolsStore.recordLLMEnd(runId, input.finishReason, input.text);
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
      devtoolsStore.recordToolCall(runId, name, args);
    });

    context.registerHook('onCompacted', (input) => {
      const runId = runIdByContext.get(input.context);
      if (runId) {
        devtoolsStore.recordCompaction(runId, input.event);
      }
    });

    context.registerHook('afterRun', (input) => {
      const runId = runIdByContext.get(input.context);
      if (runId) {
        devtoolsStore.finishRun(runId, input.result);
        runIdByContext.delete(input.context);
      }
    });
  },
};

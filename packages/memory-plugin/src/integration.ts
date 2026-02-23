import { AsyncLocalStorage } from 'async_hooks';
import { z } from 'zod';
import type { EnginePlugin, SystemPromptOption, Tool } from 'pulse-coder-engine';
import { FileMemoryPluginService } from './service.js';
import { resolveMemoryEmbeddingRuntimeConfigFromEnv } from './embedding-env.js';
import { resolveMemoryWriteRuntimeConfigFromEnv } from './write-env.js';
import type { FileMemoryServiceOptions, MemoryItem } from './types.js';

const MEMORY_RECALL_INPUT_SCHEMA = z.object({
  query: z.string().optional().describe('Natural language recall query. Defaults to current user message when omitted.'),
  limit: z.number().int().min(1).max(8).optional().describe('Maximum number of memory items to return.'),
});

const MEMORY_RECORD_INPUT_SCHEMA = z.object({
  content: z.string().min(1).describe('The memory content to store.'),
  kind: z
    .enum(['preference', 'rule', 'fix', 'profile'])
    .optional()
    .describe('Memory kind. rule/profile are user-level; preference/fix are session-level. Defaults to profile.'),
});

const MEMORY_TOOL_POLICY_APPEND = [
  '## Memory Tool Policy (On-Demand)',
  'Memory access is tool-based. Do not read/write memory on every turn.',
  'Use `memory_recall` only when memory is relevant to the current task.',
  'Use `memory_record` only when the user provides stable profile/preferences/rules or when a fix is worth remembering.',
  'If user intent conflicts with recalled memory, follow the latest user instruction.',
].join('\n');

type MemoryRecordKind = 'preference' | 'rule' | 'fix' | 'profile';

export interface MemoryRunContext {
  platformKey: string;
  sessionId: string;
  userText: string;
}

export interface MemoryRunContextAdapter {
  withContext<T>(context: MemoryRunContext, run: () => Promise<T>): Promise<T>;
  getContext(): MemoryRunContext | undefined;
}

export interface CreateMemoryEnginePluginOptions {
  service: FileMemoryPluginService;
  getRunContext: () => MemoryRunContext | undefined;
  name?: string;
  version?: string;
  toolPolicyAppend?: string;
}

export interface CreateMemoryIntegrationOptions extends FileMemoryServiceOptions {
  service?: FileMemoryPluginService;
  runContextAdapter?: MemoryRunContextAdapter;
  pluginName?: string;
  pluginVersion?: string;
  toolPolicyAppend?: string;
}

export interface CreateMemoryIntegrationFromEnvOptions extends Omit<CreateMemoryIntegrationOptions,
  'semanticRecallEnabled' | 'embeddingDimensions' | 'embeddingProvider' | 'dailyLogPolicy'> {
  env?: Record<string, string | undefined>;
}

export interface MemoryIntegration {
  service: FileMemoryPluginService;
  enginePlugin: EnginePlugin;
  initialize(): Promise<void>;
  withRunContext<T>(context: MemoryRunContext, run: () => Promise<T>): Promise<T>;
  getRunContext(): MemoryRunContext | undefined;
}

export function createMemoryIntegrationFromEnv(options: CreateMemoryIntegrationFromEnvOptions = {}): MemoryIntegration {
  const { env = process.env, ...rest } = options;
  const embedding = resolveMemoryEmbeddingRuntimeConfigFromEnv(env);
  const writePolicy = resolveMemoryWriteRuntimeConfigFromEnv(env);

  return createMemoryIntegration({
    ...rest,
    semanticRecallEnabled: embedding.semanticRecallEnabled,
    embeddingDimensions: embedding.embeddingDimensions,
    embeddingProvider: embedding.embeddingProvider,
    dailyLogPolicy: writePolicy.dailyLogPolicy,
  });
}

export function createMemoryIntegration(options: CreateMemoryIntegrationOptions = {}): MemoryIntegration {
  const {
    service,
    runContextAdapter,
    pluginName,
    pluginVersion,
    toolPolicyAppend,
    ...serviceOptions
  } = options;

  const memoryService = service ?? new FileMemoryPluginService(serviceOptions);
  const adapter = runContextAdapter ?? createAsyncLocalRunContextAdapter();
  const enginePlugin = createMemoryEnginePlugin({
    service: memoryService,
    getRunContext: () => adapter.getContext(),
    name: pluginName,
    version: pluginVersion,
    toolPolicyAppend,
  });

  return {
    service: memoryService,
    enginePlugin,
    initialize: () => memoryService.initialize(),
    withRunContext: (context, run) => adapter.withContext(context, run),
    getRunContext: () => adapter.getContext(),
  };
}

export function createMemoryEnginePlugin(options: CreateMemoryEnginePluginOptions): EnginePlugin {
  const pluginName = options.name ?? 'memory-plugin';
  const pluginVersion = options.version ?? '0.0.1';
  const policyAppend = options.toolPolicyAppend ?? MEMORY_TOOL_POLICY_APPEND;

  return {
    name: pluginName,
    version: pluginVersion,

    async initialize(context) {
      context.registerService('memoryService', options.service);

      context.registerTools({
        memory_recall: buildMemoryRecallTool(options.service, options.getRunContext),
        memory_record: buildMemoryRecordTool(options.service, options.getRunContext),
      });

      context.registerHook('beforeRun', async ({ systemPrompt }) => {
        let nextPrompt = appendSystemPrompt(systemPrompt, policyAppend);
        const runContext = options.getRunContext();
        if (!runContext) {
          return { systemPrompt: nextPrompt };
        }

        const autoInjectedPrompt = await buildAutoInjectedUserMemoryPrompt(options.service, runContext);
        console.debug(`[MemoryPlugin] Auto-injected user memory prompt: ${autoInjectedPrompt ?? 'None'}`);
        if (!autoInjectedPrompt) {
          return { systemPrompt: nextPrompt };
        }

        nextPrompt = appendSystemPrompt(nextPrompt, autoInjectedPrompt);
        return { systemPrompt: nextPrompt };
      });
    },
  };
}

function createAsyncLocalRunContextAdapter(): MemoryRunContextAdapter {
  const store = new AsyncLocalStorage<MemoryRunContext>();

  return {
    withContext<T>(context: MemoryRunContext, run: () => Promise<T>): Promise<T> {
      return store.run(context, run);
    },
    getContext() {
      return store.getStore();
    },
  };
}

function appendSystemPrompt(base: SystemPromptOption | undefined, append: string): SystemPromptOption {
  const normalizedAppend = append.trim();
  if (!normalizedAppend) {
    return base ?? { append: '' };
  }

  if (!base) {
    return { append: normalizedAppend };
  }

  if (typeof base === 'string') {
    return `${base}\n\n${normalizedAppend}`;
  }

  if (typeof base === 'function') {
    return () => `${base()}\n\n${normalizedAppend}`;
  }

  const currentAppend = base.append.trim();
  return {
    append: currentAppend ? `${currentAppend}\n\n${normalizedAppend}` : normalizedAppend,
  };
}

function requireRunContext(getRunContext: () => MemoryRunContext | undefined): MemoryRunContext {
  const runContext = getRunContext();
  if (!runContext) {
    throw new Error('memory tools require active engine run context');
  }
  return runContext;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function summarizeMemoryItem(item: MemoryItem): Record<string, unknown> {
  return {
    id: item.id,
    scope: item.scope,
    type: item.type,
    summary: item.summary,
    content: item.content,
    pinned: item.pinned,
    updatedAt: item.updatedAt,
    source: summarizeMemorySource(item),
  };
}

function summarizeMemorySource(item: MemoryItem): Record<string, unknown> | undefined {
  if (!item.sourceRef && !item.chunkId) {
    return undefined;
  }

  return {
    chunkId: item.chunkId,
    sourceRef: item.sourceRef,
  };
}

async function buildAutoInjectedUserMemoryPrompt(
  memoryService: FileMemoryPluginService,
  runContext: MemoryRunContext,
): Promise<string | undefined> {
  try {
    const listed = await memoryService.list({
      platformKey: runContext.platformKey,
      sessionId: runContext.sessionId,
      limit: 30,
    });

    const selected = listed
      .filter((item) => item.scope === 'user')
      .filter((item) => item.type === 'rule' || item.type === 'fact')
      .filter((item) => item.sourceType !== 'daily-log')
      .slice(0, 4);

    if (selected.length === 0) {
      return undefined;
    }

    const lines = [
      'Persistent user memory (auto-injected each run; follow latest user instruction on conflict):',
    ];

    let used = lines[0].length;
    for (const [index, item] of selected.entries()) {
      const flags = [item.type, item.pinned ? 'pinned' : null].filter(Boolean).join(', ');
      const summary = item.summary.trim() || item.content.trim();
      const line = `${index + 1}. (${flags}) ${summary}`;

      if (used + line.length > 520 && lines.length > 1) {
        break;
      }

      lines.push(line);
      used += line.length;
    }

    return lines.length > 1 ? lines.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

function toRecordTurnPayload(content: string, kind: MemoryRecordKind): { userText: string; assistantText: string } {
  const normalized = content.trim();
  if (kind === 'rule') {
    return {
      userText: `Rule: must follow this constraint. ${normalized}`,
      assistantText: 'Acknowledged.',
    };
  }

  if (kind === 'fix') {
    return {
      userText: `Issue context: ${normalized}`,
      assistantText: `Fixed and resolved: ${normalized}`,
    };
  }

  if (kind === 'profile') {
    return {
      userText: `Profile: ${normalized}`,
      assistantText: 'Profile captured.',
    };
  }

  return {
    userText: `Remember this preference for later: ${normalized}`,
    assistantText: 'Noted.',
  };
}

function buildMemoryRecallTool(
  memoryService: FileMemoryPluginService,
  getRunContext: () => MemoryRunContext | undefined,
): Tool<z.infer<typeof MEMORY_RECALL_INPUT_SCHEMA>, unknown> {
  return {
    name: 'memory_recall',
    description: 'Recall relevant memory items for the current user/session when needed.',
    inputSchema: MEMORY_RECALL_INPUT_SCHEMA,
    execute: async ({ query, limit }) => {
      const runContext = requireRunContext(getRunContext);
      const recallQuery = query?.trim() || runContext.userText;

      const recalled = await memoryService.recall({
        platformKey: runContext.platformKey,
        sessionId: runContext.sessionId,
        query: recallQuery,
        limit,
      });

      return {
        enabled: recalled.enabled,
        count: recalled.items.length,
        query: recallQuery,
        promptAppend: recalled.promptAppend,
        items: recalled.items.map((item) => summarizeMemoryItem(item)),
      };
    },
  };
}

function buildMemoryRecordTool(
  memoryService: FileMemoryPluginService,
  getRunContext: () => MemoryRunContext | undefined,
): Tool<z.infer<typeof MEMORY_RECORD_INPUT_SCHEMA>, unknown> {
  return {
    name: 'memory_record',
    description: 'Persist an important preference/rule/fix/profile into memory when explicitly useful.',
    inputSchema: MEMORY_RECORD_INPUT_SCHEMA,
    execute: async ({ content, kind }) => {
      const runContext = requireRunContext(getRunContext);
      const normalizedContent = content.trim();
      const normalizedKind: MemoryRecordKind = kind ?? 'profile';
      const payload = toRecordTurnPayload(normalizedContent, normalizedKind);

      await memoryService.recordTurn({
        platformKey: runContext.platformKey,
        sessionId: runContext.sessionId,
        userText: payload.userText,
        assistantText: payload.assistantText,
        sourceType: 'explicit',
      });

      const list = await memoryService.list({
        platformKey: runContext.platformKey,
        sessionId: runContext.sessionId,
        limit: 20,
      });

      const normalizedTarget = normalizeText(normalizedContent);
      const matched = list.find((item) => {
        const contentMatch = normalizeText(item.content).includes(normalizedTarget);
        const summaryMatch = normalizeText(item.summary).includes(normalizedTarget);
        return contentMatch || summaryMatch;
      });

      return {
        ok: true,
        kind: normalizedKind,
        stored: Boolean(matched),
        item: matched ? summarizeMemoryItem(matched) : undefined,
      };
    },
  };
}

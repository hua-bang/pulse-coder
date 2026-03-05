import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { ModelMessage } from 'ai';
import type { SystemPromptOption, Tool } from '../../shared/types';
import { z } from 'zod';
import {
  buildToolSearchReferenceResult,
  buildToolSearchSummary,
  filterImmediateTools,
  getSearchableToolCatalog,
  searchToolsBm25,
  searchToolsRegex,
  type ToolSearchVariant,
} from './utils';

type ToolSearchResultPayload = {
  type: 'tool_search_tool_search_result';
  tool_references: Array<{ type: 'tool_reference'; tool_name: string }>;
};

type ToolSearchConfig = {
  enabled: boolean;
  variant: ToolSearchVariant;
  limit: number;
  candidates: number;
  maxRegexQueryLength: number;
  exposeSummary: boolean;
};

const DEFAULT_CONFIG: ToolSearchConfig = {
  enabled: true,
  variant: 'bm25',
  limit: 10,
  candidates: 20,
  maxRegexQueryLength: 200,
  exposeSummary: true,
};

const TOOL_SEARCH_SERVICE_NAME = 'toolSearchService';

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const VALID_VARIANTS: ToolSearchVariant[] = ['regex', 'bm25'];

const buildConfig = (): ToolSearchConfig => {
  const rawVariant = process.env.PULSE_CODER_TOOL_SEARCH_VARIANT;
  const variant = VALID_VARIANTS.includes(rawVariant as ToolSearchVariant)
    ? (rawVariant as ToolSearchVariant)
    : DEFAULT_CONFIG.variant;

  return {
    enabled: parseBoolean(process.env.PULSE_CODER_TOOL_SEARCH_ENABLED, DEFAULT_CONFIG.enabled),
    variant,
    limit: parseNumber(process.env.PULSE_CODER_TOOL_SEARCH_LIMIT, DEFAULT_CONFIG.limit),
    candidates: parseNumber(process.env.PULSE_CODER_TOOL_SEARCH_CANDIDATES, DEFAULT_CONFIG.candidates),
    maxRegexQueryLength: parseNumber(
      process.env.PULSE_CODER_TOOL_SEARCH_MAX_REGEX_LENGTH,
      DEFAULT_CONFIG.maxRegexQueryLength
    ),
    exposeSummary: parseBoolean(process.env.PULSE_CODER_TOOL_SEARCH_SUMMARY, DEFAULT_CONFIG.exposeSummary),
  };
};

const searchToolSchema = z.object({
  query: z.string().describe('Query string for tool search'),
  limit: z.number().optional().describe('Maximum number of tools to return'),
});

type SearchToolInput = z.infer<typeof searchToolSchema>;

function selectSearchTools(tools: Record<string, Tool>): Record<string, Tool> {
  return getSearchableToolCatalog(tools);
}

function buildSearchResult(
  tools: Record<string, Tool>,
  input: SearchToolInput,
  variant: ToolSearchVariant,
  config: ToolSearchConfig
): ToolSearchResultPayload {
  const effectiveLimit = input.limit ?? config.limit;
  const effectiveCatalog = getSearchableToolCatalog(tools);

  if (variant === 'regex') {
    const query = input.query;
    if (query.length > config.maxRegexQueryLength) {
      throw new Error(`Regex query exceeds ${config.maxRegexQueryLength} characters`);
    }
    const matches = searchToolsRegex(effectiveCatalog, query, { limit: effectiveLimit });
    return buildToolSearchReferenceResult(matches, { limit: effectiveLimit });
  }

  const matches = searchToolsBm25(effectiveCatalog, input.query, {
    limit: effectiveLimit,
    candidates: config.candidates,
  });
  return buildToolSearchReferenceResult(matches, { limit: effectiveLimit });
}

function createRegexTool(context: EnginePluginContext, config: ToolSearchConfig): Tool<SearchToolInput, ToolSearchResultPayload> {
  return {
    name: 'tool_search_tool_regex',
    description: 'Search available tools using a Python-style regex query.',
    inputSchema: searchToolSchema,
    execute: async (input: SearchToolInput) => {
      const tools = context.getEngineInstance().tools;
      return buildSearchResult(tools, input, 'regex', config);
    },
  };
}

function createBm25Tool(context: EnginePluginContext, config: ToolSearchConfig): Tool<SearchToolInput, ToolSearchResultPayload> {
  return {
    name: 'tool_search_tool_bm25',
    description: 'Search available tools using natural language queries.',
    inputSchema: searchToolSchema,
    execute: async (input: SearchToolInput) => {
      const tools = context.getEngineInstance().tools;
      return buildSearchResult(tools, input, 'bm25', config);
    },
  };
}

function buildToolSearchSystemAppend(tools: Record<string, Tool>, config: ToolSearchConfig): string {
  const lines: string[] = [
    'Tool search is available for deferred tools.',
    'Use tool_search_tool_bm25 for natural language queries, or tool_search_tool_regex for regex.',
    'Deferred tools are not listed explicitly; use tool search and call tools by name after discovery.',
  ];

  if (config.exposeSummary) {
    lines.push(buildToolSearchSummary(tools));
  }

  return lines.join('\n');
}

class ToolSearchService {
  private readonly config: ToolSearchConfig;
  private readonly logger: EnginePluginContext['logger'];
  private readonly loadedToolNames = new Set<string>();

  constructor(config: ToolSearchConfig, logger: EnginePluginContext['logger']) {
    this.config = config;
    this.logger = logger;
  }

  getConfig(): ToolSearchConfig {
    return this.config;
  }

  buildSystemPrompt(tools: Record<string, Tool>): string {
    return buildToolSearchSystemAppend(tools, this.config);
  }

  splitTools(tools: Record<string, Tool>): { immediate: Record<string, Tool>; deferred: Record<string, Tool> } {
    return {
      immediate: filterImmediateTools(tools),
      deferred: selectSearchTools(tools),
    };
  }

  getLoadedTools(tools: Record<string, Tool>): Record<string, Tool> {
    const loaded: Record<string, Tool> = {};
    for (const name of this.loadedToolNames) {
      const tool = tools[name];
      if (tool) {
        loaded[name] = tool;
      }
    }
    return loaded;
  }

  addLoadedTools(toolNames: string[]): string[] {
    const added: string[] = [];
    for (const name of toolNames) {
      if (!name || this.loadedToolNames.has(name)) {
        continue;
      }
      this.loadedToolNames.add(name);
      added.push(name);
    }
    return added;
  }

  resetLoadedTools(): void {
    this.loadedToolNames.clear();
  }
}

function appendSystemPrompt(base: SystemPromptOption | undefined, append: string): SystemPromptOption {
  if (!append.trim()) {
    return base ?? { append: '' };
  }

  if (!base) {
    return { append };
  }

  if (typeof base === 'string') {
    return `${base}\n\n${append}`;
  }

  if (typeof base === 'function') {
    return () => `${base()}\n\n${append}`;
  }

  const currentAppend = base.append.trim();
  return {
    append: currentAppend ? `${currentAppend}\n\n${append}` : append,
  };
}

function extractToolReferences(messages: ModelMessage[]): string[] {
  if (!messages.length) {
    return [];
  }

  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'tool') {
    return [];
  }

  if (!Array.isArray(latest.content)) {
    return [];
  }

  const references: string[] = [];
  for (const part of latest.content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const type = (part as { type?: string }).type;
    if (type !== 'tool-result') {
      continue;
    }

    const result = (part as { output?: any }).output?.value as { tool_references?: Array<{ tool_name?: string }> } | undefined;
    const toolReferences = result?.tool_references;
    if (!Array.isArray(toolReferences)) {
      continue;
    }

    for (const ref of toolReferences) {
      const toolName = ref?.tool_name;
      if (!toolName) {
        continue;
      }
      references.push(toolName);
    }
  }

  return references;
}

export const builtInToolSearchPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-tool-search',
  version: '0.1.0',
  async initialize(context: EnginePluginContext) {
    const config = buildConfig();
    if (!config.enabled) {
      context.logger.info('[ToolSearch] Disabled via config');
      return;
    }

    const regexTool = createRegexTool(context, config);
    const bm25Tool = createBm25Tool(context, config);

    context.registerTool(regexTool.name, regexTool);
    context.registerTool(bm25Tool.name, bm25Tool);

    const service = new ToolSearchService(config, context.logger);
    context.registerService(TOOL_SEARCH_SERVICE_NAME, service);

    context.registerHook('beforeRun', () => {
      service.resetLoadedTools();
    });

    context.registerHook('beforeLLMCall', ({ tools, systemPrompt }) => {
      const toolSearchService = context.getService<ToolSearchService>(TOOL_SEARCH_SERVICE_NAME) ?? service;
      const split = toolSearchService.splitTools(tools);
      const loadedTools = toolSearchService.getLoadedTools(tools);
      const nextPrompt = appendSystemPrompt(systemPrompt, toolSearchService.buildSystemPrompt(tools));

      return {
        tools: {
          ...split.immediate,
          ...loadedTools,
          [regexTool.name]: regexTool,
          [bm25Tool.name]: bm25Tool,
        },
        systemPrompt: nextPrompt,
      };
    });

    context.registerHook('afterLLMCall', ({ context: runContext, finishReason }) => {
      if (finishReason !== 'tool-calls') {
        return;
      }

      const references = extractToolReferences(runContext.messages);
      if (references.length === 0) {
        return;
      }

      const added = service.addLoadedTools(references);
      if (added.length === 0) {
        return;
      }

      runContext.messages.push({
        role: 'system',
        content: `Tool search loaded: ${added.join(', ')}`,
      });
    });

    context.logger.info('[ToolSearch] Built-in tool search plugin initialized', {
      variant: config.variant,
      limit: config.limit,
      candidates: config.candidates,
    });
  },
};

export default builtInToolSearchPlugin;

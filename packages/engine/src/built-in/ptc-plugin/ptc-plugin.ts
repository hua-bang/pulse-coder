import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { SystemPromptOption, Tool, ToolExecutionContext } from '../../shared/types';

type ToolWithPtc = Tool & {
  ptc?: {
    allowed_callers?: string[];
  };
};

type PtcConfig = {
  enabled: boolean;
  strict: boolean;
  appendPrompt: boolean;
  appendPromptMaxTools: number;
};

type PtcSnapshot = {
  active: boolean;
  callerSelectors: string[];
  exposedToolNames: string[];
};

const PTC_SERVICE_NAME = 'ptcService';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeCallerList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return unique(
    raw
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function normalizeCallerToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function addCallerToken(target: Set<string>, value: unknown): void {
  const normalized = normalizeCallerToken(value);
  if (normalized) {
    target.add(normalized);
  }
}

function resolveCallerSelectors(runContext?: Record<string, any>): string[] {
  if (!runContext || typeof runContext !== 'object') {
    return [];
  }

  const selectors = new Set<string>();
  const rawSelectors = runContext.callerSelectors;

  if (typeof rawSelectors === 'string') {
    addCallerToken(selectors, rawSelectors);
  } else if (Array.isArray(rawSelectors)) {
    for (const selector of rawSelectors) {
      addCallerToken(selectors, selector);
    }
  }

  addCallerToken(selectors, runContext.caller);

  return [...selectors];
}

function isCallerAllowed(allowedCallers: string[], callerSelectors: string[]): boolean {
  if (allowedCallers.length === 0) {
    return true;
  }

  const selectorSet = new Set<string>();
  for (const selector of callerSelectors) {
    const normalized = normalizeCallerToken(selector);
    if (normalized) {
      selectorSet.add(normalized);
    }
  }

  for (const allowed of allowedCallers) {
    const normalized = normalizeCallerToken(allowed);
    if (!normalized) {
      continue;
    }

    if (normalized === '*') {
      return true;
    }

    if (selectorSet.has(normalized)) {
      return true;
    }
  }

  return false;
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

function buildConfigFromEnv(): PtcConfig {
  return {
    enabled: parseBoolean(process.env.PULSE_CODER_PTC_ENABLED, true),
    strict: parseBoolean(process.env.PULSE_CODER_PTC_STRICT, false),
    appendPrompt: parseBoolean(process.env.PULSE_CODER_PTC_APPEND_PROMPT, false),
    appendPromptMaxTools: parsePositiveInt(process.env.PULSE_CODER_PTC_APPEND_PROMPT_MAX_TOOLS, 12),
  };
}

function failOrWarn(context: EnginePluginContext, strict: boolean, message: string): void {
  if (strict) {
    throw new Error(`[PTC] ${message}`);
  }
  context.logger.warn(`[PTC] ${message}`);
}

function resolveAllowedCallers(
  context: EnginePluginContext,
  config: PtcConfig,
  toolName: string,
  tool: ToolWithPtc,
): string[] | undefined {
  if (tool.allowed_callers !== undefined && !Array.isArray(tool.allowed_callers)) {
    failOrWarn(context, config.strict, `Tool "${toolName}" has invalid allowed_callers.`);
  }

  if (tool.ptc?.allowed_callers !== undefined && !Array.isArray(tool.ptc.allowed_callers)) {
    failOrWarn(context, config.strict, `Tool "${toolName}" has invalid ptc.allowed_callers.`);
  }

  const topLevelMany = normalizeCallerList(tool.allowed_callers);
  const ptcMany = normalizeCallerList(tool.ptc?.allowed_callers);
  const merged = unique([...topLevelMany, ...ptcMany]);

  return merged.length > 0 ? merged : undefined;
}

function buildPromptHint(snapshot: PtcSnapshot, maxTools: number): string {
  if (!snapshot.active || snapshot.exposedToolNames.length === 0) {
    return 'PTC plugin active. No tools are currently exposed to any caller.';
  }

  const visibleNames = snapshot.exposedToolNames.slice(0, maxTools);
  const suffix = snapshot.exposedToolNames.length > visibleNames.length
    ? ` ... (+${snapshot.exposedToolNames.length - visibleNames.length} more)`
    : '';

  return [
    'PTC plugin active.',
    `PTC caller selectors: ${snapshot.callerSelectors.length > 0 ? snapshot.callerSelectors.join(', ') : '(none)'}`,
    `Tools exposed to callers: ${visibleNames.join(', ')}${suffix}`,
  ].join('\n');
}

class PtcService {
  private callerSelectors: string[] = [];

  private snapshot: PtcSnapshot = {
    active: false,
    callerSelectors: [],
    exposedToolNames: [],
  };

  setCallerSelectors(selectors: string[]): void {
    this.callerSelectors = selectors;
  }

  getCallerSelectors(): string[] {
    return this.callerSelectors;
  }

  setSnapshot(snapshot: PtcSnapshot): void {
    this.snapshot = snapshot;
  }

  getSnapshot(): PtcSnapshot {
    return this.snapshot;
  }
}

export const builtInPtcPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-ptc',
  version: '0.1.0',
  async initialize(context: EnginePluginContext) {
    const config = buildConfigFromEnv();
    if (!config.enabled) {
      context.logger.info('[PTC] Disabled via config');
      return;
    }

    const service = new PtcService();
    context.registerService(PTC_SERVICE_NAME, service);

    context.registerHook('beforeRun', ({ runContext }) => {
      const callerSelectors = resolveCallerSelectors(runContext);
      service.setCallerSelectors(callerSelectors);
      service.setSnapshot({
        active: true,
        callerSelectors,
        exposedToolNames: [],
      });
    });

    context.registerHook('beforeLLMCall', ({ tools, systemPrompt }) => {
      const callerSelectors = service.getCallerSelectors();
      const nextTools: Record<string, Tool> = {};
      const exposedToolNames: string[] = [];

      for (const [toolName, originalTool] of Object.entries(tools)) {
        const tool = originalTool as ToolWithPtc;
        const allowedCallers = resolveAllowedCallers(context, config, toolName, tool);

        if (!allowedCallers || isCallerAllowed(allowedCallers, callerSelectors)) {
          nextTools[toolName] = {
            ...tool,
            execute: async (input: unknown, executionContext?: ToolExecutionContext) => {
              if (!allowedCallers) {
                return await tool.execute(input, executionContext);
              }

              const runtimeSelectors = resolveCallerSelectors(executionContext?.runContext);
              const selectors = runtimeSelectors.length > 0 ? runtimeSelectors : callerSelectors;
              if (!isCallerAllowed(allowedCallers, selectors)) {
                throw new Error(`[PTC] Tool "${toolName}" is not allowed for the current caller.`);
              }
              return await tool.execute(input, executionContext);
            },
          } as Tool;
          exposedToolNames.push(toolName);
        }
      }

      const snapshot: PtcSnapshot = {
        active: true,
        callerSelectors,
        exposedToolNames,
      };
      service.setSnapshot(snapshot);

      if (!config.appendPrompt) {
        return { tools: nextTools };
      }

      return {
        tools: nextTools,
        systemPrompt: appendSystemPrompt(systemPrompt, buildPromptHint(snapshot, config.appendPromptMaxTools)),
      };
    });

    context.logger.info('[PTC] Built-in PTC plugin initialized', {
      strict: config.strict,
      appendPrompt: config.appendPrompt,
    });
  },
};

export default builtInPtcPlugin;

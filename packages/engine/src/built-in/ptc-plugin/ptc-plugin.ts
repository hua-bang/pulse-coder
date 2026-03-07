import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { SystemPromptOption, Tool } from '../../shared/types';

type ToolWithPtc = Tool & {
  ptc?: {
    allowed_callers?: string[];
  };
  allowed_callers?: string[];
};

type PtcConfig = {
  enabled: boolean;
  strict: boolean;
  appendPrompt: boolean;
  appendPromptMaxTools: number;
};

type PtcSnapshot = {
  active: boolean;
  callerTypes: string[];
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
    failOrWarn(context, config.strict, `Tool "${toolName}" has invalid allowed_callers at top level.`);
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
    `PTC caller types: ${snapshot.callerTypes.join(', ')}`,
    `Tools exposed to callers: ${visibleNames.join(', ')}${suffix}`,
  ].join('\n');
}

class PtcService {
  private snapshot: PtcSnapshot = {
    active: false,
    callerTypes: [],
    exposedToolNames: [],
  };

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

    context.registerHook('beforeRun', () => {
      service.setSnapshot({
        active: true,
        callerTypes: [],
        exposedToolNames: [],
      });
    });

    context.registerHook('beforeLLMCall', ({ tools, systemPrompt }) => {
      const nextTools: Record<string, Tool> = { ...tools };
      const exposedToolNames: string[] = [];
      const callerTypes: string[] = [];

      for (const [toolName, originalTool] of Object.entries(tools)) {
        const tool = originalTool as ToolWithPtc;
        const allowedCallers = resolveAllowedCallers(context, config, toolName, tool);
        if (!allowedCallers) {
          continue;
        }

        nextTools[toolName] = {
          ...tool,
          allowed_callers: allowedCallers,
        } as Tool;

        exposedToolNames.push(toolName);
        callerTypes.push(...allowedCallers);
      }

      const snapshot: PtcSnapshot = {
        active: true,
        callerTypes: unique(callerTypes),
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

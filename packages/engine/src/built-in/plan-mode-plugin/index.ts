import type { EventEmitter } from 'events';
import type { ModelMessage } from 'ai';

import type { SystemPromptOption } from '../../shared/types';
import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';

export type PlanMode = 'planning' | 'executing';
export type PlanIntentLabel = 'PLAN_ONLY' | 'EXECUTE_NOW' | 'UNCLEAR';
export type ToolCategory = 'read' | 'search' | 'write' | 'execute' | 'other';
export type ToolRisk = 'low' | 'medium' | 'high';

export type PlanModeEventName =
  | 'mode_entered'
  | 'execution_intent_detected'
  | 'mode_switched_by_intent'
  | 'disallowed_tool_attempt_in_planning';

export interface ToolMeta {
  name: string;
  category: ToolCategory;
  risk: ToolRisk;
  description: string;
  examples?: string[];
}

export interface ModePolicy {
  mode: PlanMode;
  allowedCategories: ToolCategory[];
  disallowedCategories: ToolCategory[];
  notes?: string;
}

export interface PlanModeEvent {
  name: PlanModeEventName;
  mode: PlanMode;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export interface PlanModeTransitionResult {
  modeBefore: PlanMode;
  modeAfter: PlanMode;
  switched: boolean;
  intent: PlanIntentLabel;
  userInput: string;
}

export interface PlanModeService {
  getMode(): PlanMode;
  setMode(mode: PlanMode, reason?: string): void;
  detectIntent(input: string): PlanIntentLabel;
  processContextMessages(messages: ModelMessage[]): PlanModeTransitionResult;
  getModePolicy(mode?: PlanMode): ModePolicy;
  getToolMetadata(toolNames: string[]): ToolMeta[];
  buildPromptAppend(toolNames: string[], transition?: PlanModeTransitionResult): string;
  getEvents(limit?: number): PlanModeEvent[];
}

type LoggerLike = EnginePluginContext['logger'];

const PLANNING_POLICY: ModePolicy = {
  mode: 'planning',
  allowedCategories: ['read', 'search', 'other'],
  disallowedCategories: ['write', 'execute'],
  notes:
    'Planning mode is prompt-constrained only. Disallowed tool attempts are observed and logged, not hard-blocked.'
};

const EXECUTING_POLICY: ModePolicy = {
  mode: 'executing',
  allowedCategories: ['read', 'search', 'write', 'execute', 'other'],
  disallowedCategories: []
};

const EXECUTE_PATTERNS: RegExp[] = [
  /开始执行/i,
  /按这个计划做/i,
  /可以改代码了/i,
  /直接实现/i,
  /go\s+ahead/i,
  /proceed/i,
  /implement\s+it/i,
  /start\s+implement/i,
  /start\s+coding/i
];

const NEGATIVE_PATTERNS: RegExp[] = [
  /先不(要)?执行/i,
  /先别执行/i,
  /不要执行/i,
  /暂时不要执行/i,
  /先别改代码/i,
  /先不要改代码/i,
  /先不要实现/i,
  /not\s+now/i,
  /hold\s+off/i,
  /do\s+not\s+(start|execute|implement|proceed)/i,
  /don't\s+(start|execute|implement|proceed)/i
];

const PLAN_PATTERNS: RegExp[] = [/先计划/i, /先分析/i, /先出方案/i, /plan\s+first/i, /analysis\s+first/i];


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
    append: currentAppend ? `${currentAppend}\n\n${append}` : append
  };
}

const KNOWN_TOOL_META: Record<string, Omit<ToolMeta, 'name'>> = {
  read: {
    category: 'read',
    risk: 'low',
    description: 'Read file contents from the workspace.'
  },
  ls: {
    category: 'read',
    risk: 'low',
    description: 'List files and directories.'
  },
  grep: {
    category: 'search',
    risk: 'low',
    description: 'Search text content across files.'
  },
  tavily: {
    category: 'search',
    risk: 'low',
    description: 'Search web results from external sources.'
  },
  tavily_extract: {
    category: 'search',
    risk: 'low',
    description: 'Extract cleaned page content from specific URLs.'
  },
  tavily_crawl: {
    category: 'search',
    risk: 'low',
    description: 'Crawl websites and collect multi-page content.'
  },
  tavily_map: {
    category: 'search',
    risk: 'low',
    description: 'Discover URLs from a base site without full extraction.'
  },
  skill: {
    category: 'search',
    risk: 'low',
    description: 'Load procedural guidance from installed skills.'
  },
  write: {
    category: 'write',
    risk: 'high',
    description: 'Create or overwrite file content.'
  },
  edit: {
    category: 'write',
    risk: 'high',
    description: 'Modify existing files using exact replacements.'
  },
  bash: {
    category: 'execute',
    risk: 'high',
    description: 'Execute shell commands.'
  },
  clarify: {
    category: 'other',
    risk: 'low',
    description: 'Ask the user a targeted clarification question.'
  },
  task_create: {
    category: 'other',
    risk: 'low',
    description: 'Create tracked task entries for planning and execution visibility.'
  },
  task_get: {
    category: 'other',
    risk: 'low',
    description: 'Inspect a task entry by ID.'
  },
  task_list: {
    category: 'other',
    risk: 'low',
    description: 'List task tracking entries and status summary.'
  },
  task_update: {
    category: 'other',
    risk: 'low',
    description: 'Update task tracking fields and status.'
  }
};

class BuiltInPlanModeService implements PlanModeService {
  private mode: PlanMode;
  private readonly events: PlanModeEvent[] = [];

  constructor(
    private readonly logger: LoggerLike,
    private readonly eventEmitter: EventEmitter,
    initialMode: PlanMode = 'executing'
  ) {
    this.mode = initialMode;
    this.emitEvent('mode_entered', { reason: 'initialize' });
  }

  getMode(): PlanMode {
    return this.mode;
  }

  setMode(mode: PlanMode, reason: string = 'manual'): void {
    if (this.mode === mode) {
      return;
    }

    this.mode = mode;
    this.emitEvent('mode_entered', { reason });
  }

  detectIntent(input: string): PlanIntentLabel {
    const text = input.trim();
    if (!text) {
      return 'UNCLEAR';
    }

    if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'PLAN_ONLY';
    }

    if (EXECUTE_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'EXECUTE_NOW';
    }

    if (PLAN_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'PLAN_ONLY';
    }

    return 'UNCLEAR';
  }

  processContextMessages(messages: ModelMessage[]): PlanModeTransitionResult {
    const userInput = this.getLatestUserText(messages);
    const modeBefore = this.mode;

    if (!userInput) {
      return {
        modeBefore,
        modeAfter: this.mode,
        switched: false,
        intent: 'UNCLEAR',
        userInput: ''
      };
    }

    const intent = this.detectIntent(userInput);

    if (intent === 'EXECUTE_NOW') {
      this.emitEvent('execution_intent_detected', { intent, userInput });

      if (this.mode === 'planning') {
        this.mode = 'executing';
        this.emitEvent('mode_switched_by_intent', {
          from: 'planning',
          to: 'executing',
          userInput
        });
        this.emitEvent('mode_entered', {
          reason: 'intent',
          from: 'planning'
        });
      }
    }

    return {
      modeBefore,
      modeAfter: this.mode,
      switched: modeBefore !== this.mode,
      intent,
      userInput
    };
  }

  getModePolicy(mode: PlanMode = this.mode): ModePolicy {
    return mode === 'planning' ? PLANNING_POLICY : EXECUTING_POLICY;
  }

  getToolMetadata(toolNames: string[]): ToolMeta[] {
    return Array.from(new Set(toolNames)).sort().map((name) => this.inferToolMeta(name));
  }

  buildPromptAppend(toolNames: string[], transition?: PlanModeTransitionResult): string {
    const mode = this.mode;
    const policy = this.getModePolicy(mode);
    const toolMeta = this.getToolMetadata(toolNames);
    const shownTools = toolMeta.slice(0, 40);
    const omittedCount = toolMeta.length - shownTools.length;

    const lines: string[] = [
      '## Plan Mode Policy (Built-in Plugin)',
      `Current mode: ${mode.toUpperCase()}`,
      `Allowed tool categories: ${policy.allowedCategories.join(', ')}`,
      `Disallowed tool categories: ${policy.disallowedCategories.join(', ') || 'none'}`,
      policy.notes ? `Policy notes: ${policy.notes}` : ''
    ].filter(Boolean);

    if (mode === 'planning') {
      lines.push(
        'Planning objective: prioritize reading, analysis, and plan generation.',
        'In planning mode, do not intentionally perform write/edit/execute actions.',
        'If implementation is requested but intent is not explicit, ask for execution authorization.',
        'Before each tool call in planning mode, self-check category compliance.',
        'Plan format must include: goals, assumptions, steps, risks, validation approach.'
      );
    } else {
      lines.push(
        'Executing objective: follow the agreed plan before broad exploration.',
        'Make targeted edits and keep changes scoped.',
        'Report what changed and how it was validated.'
      );
    }

    if (transition?.switched && transition.modeAfter === 'executing') {
      lines.push(
        'Mode transition: the latest user message explicitly authorized execution.',
        'In your next reply, acknowledge switching to EXECUTING mode before implementation details.'
      );
    }

    lines.push('Tool metadata (prompt-level policy reference):');
    for (const meta of shownTools) {
      lines.push(`- ${meta.name}: category=${meta.category}, risk=${meta.risk}, ${meta.description}`);
    }

    if (omittedCount > 0) {
      lines.push(`- ... ${omittedCount} additional tool(s) omitted for brevity.`);
    }

    return lines.join('\n');
  }

  getEvents(limit: number = 50): PlanModeEvent[] {
    return this.events.slice(-Math.max(0, limit));
  }

  observePotentialPolicyViolation(toolName: string, input: unknown): void {
    if (this.mode !== 'planning') {
      return;
    }

    const meta = this.inferToolMeta(toolName);
    const policy = this.getModePolicy('planning');

    if (!policy.disallowedCategories.includes(meta.category)) {
      return;
    }

    this.emitEvent('disallowed_tool_attempt_in_planning', {
      toolName,
      category: meta.category,
      risk: meta.risk,
      input
    });
  }

  private inferToolMeta(name: string): ToolMeta {
    const knownMeta = KNOWN_TOOL_META[name];
    if (knownMeta) {
      return {
        name,
        ...knownMeta
      };
    }

    if (name.startsWith('mcp_')) {
      return {
        name,
        category: 'execute',
        risk: 'medium',
        description: 'MCP external tool invocation.'
      };
    }

    if (name.endsWith('_agent')) {
      return {
        name,
        category: 'execute',
        risk: 'high',
        description: 'Sub-agent task execution tool.'
      };
    }

    if (/read|list|cat/i.test(name)) {
      return {
        name,
        category: 'read',
        risk: 'low',
        description: 'Likely a read-only inspection tool inferred by name.'
      };
    }

    if (/search|find|query|grep/i.test(name)) {
      return {
        name,
        category: 'search',
        risk: 'low',
        description: 'Likely a search tool inferred by name.'
      };
    }

    if (/write|edit|patch|update|create|delete|remove/i.test(name)) {
      return {
        name,
        category: 'write',
        risk: 'high',
        description: 'Likely a file-modifying tool inferred by name.'
      };
    }

    if (/bash|exec|run|shell|deploy|build|test/i.test(name)) {
      return {
        name,
        category: 'execute',
        risk: 'high',
        description: 'Likely a command execution tool inferred by name.'
      };
    }

    return {
      name,
      category: 'other',
      risk: 'low',
      description: 'Tool category could not be inferred with high confidence.'
    };
  }

  private getLatestUserText(messages: ModelMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') {
        continue;
      }

      return this.messageContentToText(message.content);
    }

    return '';
  }

  private messageContentToText(content: ModelMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    const textParts: string[] = [];

    for (const part of content) {
      if (typeof part === 'string') {
        textParts.push(part);
        continue;
      }

      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }

    return textParts.join('\n');
  }

  private emitEvent(name: PlanModeEventName, payload?: Record<string, unknown>): void {
    const event: PlanModeEvent = {
      name,
      mode: this.mode,
      timestamp: Date.now(),
      payload
    };

    this.events.push(event);
    if (this.events.length > 500) {
      this.events.shift();
    }

    this.eventEmitter.emit(name, event);
    this.eventEmitter.emit('plan_mode_event', event);

    if (name === 'disallowed_tool_attempt_in_planning') {
      this.logger.warn('[PlanMode] Soft violation detected in planning mode', payload);
      return;
    }

    this.logger.info(`[PlanMode] ${name}`, payload);
  }
}

export const builtInPlanModePlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-plan-mode',
  version: '1.0.0',

  async initialize(context: EnginePluginContext): Promise<void> {
    const service = new BuiltInPlanModeService(context.logger, context.events, 'executing');

    // Inject plan-mode system prompt before each LLM call
    context.registerHook('beforeLLMCall', ({ context: runContext, tools, systemPrompt }) => {
      const mode = service.getMode();
      if (mode === 'executing') {
        return;
      }

      const transition = service.processContextMessages(runContext.messages);
      const append = service.buildPromptAppend(Object.keys(tools), transition);
      const finalSystemPrompt = appendSystemPrompt(systemPrompt, append);

      return { systemPrompt: finalSystemPrompt };
    });

    // Observe tool calls for policy violations in planning mode
    context.registerHook('beforeToolCall', ({ name, input }) => {
      service.observePotentialPolicyViolation(name, input);
    });

    context.registerService('planMode', service);
    context.registerService('planModeService', service);

    context.logger.info('[PlanMode] Built-in plan mode plugin initialized', {
      mode: service.getMode()
    });
  }
};

export { BuiltInPlanModeService };

export default builtInPlanModePlugin;

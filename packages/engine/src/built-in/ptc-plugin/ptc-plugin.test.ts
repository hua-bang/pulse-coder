import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineHookMap, EngineHookName, EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { Tool } from '../../shared/types.js';
import { builtInPtcPlugin } from './ptc-plugin.js';

type HookStore = {
  [K in EngineHookName]?: Array<EngineHookMap[K]>;
};

function createPluginContext() {
  const hooks: HookStore = {};
  const services = new Map<string, unknown>();

  const context: EnginePluginContext = {
    registerTool: () => undefined,
    registerTools: () => undefined,
    getTool: () => undefined,
    getTools: () => ({}),
    getEngineInstance: () => ({ tools: {} }),
    registerHook: (hookName, handler) => {
      (hooks[hookName] ??= []).push(handler as never);
    },
    registerService: (name, service) => {
      services.set(name, service);
    },
    getService: (name) => services.get(name),
    getConfig: () => undefined,
    setConfig: () => undefined,
    events: { emit: () => true } as never,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  return { context, hooks };
}

function firstHook<K extends EngineHookName>(hooks: HookStore, name: K): EngineHookMap[K] {
  const handlers = hooks[name];
  if (!handlers || handlers.length === 0) {
    throw new Error(`Missing hook: ${name}`);
  }
  return handlers[0] as EngineHookMap[K];
}

describe('builtInPtcPlugin', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PULSE_CODER_PTC_ENABLED', 'true');
    vi.stubEnv('PULSE_CODER_PTC_APPEND_PROMPT', 'false');
    vi.stubEnv('PULSE_CODER_PTC_STRICT', 'false');
  });

  it('filters tools by allowed_callers using runContext.callerSelectors', async () => {
    const { context, hooks } = createPluginContext();
    await builtInPtcPlugin.initialize(context);

    const beforeRun = firstHook(hooks, 'beforeRun');
    const beforeLLMCall = firstHook(hooks, 'beforeLLMCall');

    await beforeRun({
      context: { messages: [] },
      tools: {},
      runContext: {
        callerSelectors: ['discord:thread'],
      },
    });

    const publicToolExecute = vi.fn(async () => 'public');
    const threadToolExecute = vi.fn(async () => 'discord-thread');
    const feishuToolExecute = vi.fn(async () => 'feishu-group');

    const tools: Record<string, Tool> = {
      public_tool: {
        name: 'public_tool',
        description: 'always available',
        inputSchema: {} as never,
        execute: publicToolExecute,
      },
      discord_thread_tool: {
        name: 'discord_thread_tool',
        description: 'discord thread only',
        inputSchema: {} as never,
        allowed_callers: ['discord:thread'],
        execute: threadToolExecute,
      },
      feishu_group_tool: {
        name: 'feishu_group_tool',
        description: 'feishu group only',
        inputSchema: {} as never,
        ptc: {
          allowed_callers: ['feishu:group'],
        },
        execute: feishuToolExecute,
      } as Tool,
    };

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools,
      systemPrompt: undefined,
    });

    expect(result?.tools).toBeDefined();
    expect(Object.keys(result!.tools!)).toContain('public_tool');
    expect(Object.keys(result!.tools!)).toContain('discord_thread_tool');
    expect(Object.keys(result!.tools!)).not.toContain('feishu_group_tool');
  });

  it('supports runContext.caller fallback for selector matching', async () => {
    const { context, hooks } = createPluginContext();
    await builtInPtcPlugin.initialize(context);

    const beforeRun = firstHook(hooks, 'beforeRun');
    const beforeLLMCall = firstHook(hooks, 'beforeLLMCall');

    await beforeRun({
      context: { messages: [] },
      tools: {},
      runContext: {
        caller: 'cron',
      },
    });

    const cronExecute = vi.fn(async () => 'ok');
    const tools: Record<string, Tool> = {
      cron_only_tool: {
        name: 'cron_only_tool',
        description: 'cron only',
        inputSchema: {} as never,
        allowed_callers: ['cron'],
        execute: cronExecute,
      },
    };

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools,
      systemPrompt: undefined,
    });

    expect(result?.tools?.cron_only_tool).toBeDefined();
  });

  it('blocks runtime execution when execution runContext does not match allowed_callers', async () => {
    const { context, hooks } = createPluginContext();
    await builtInPtcPlugin.initialize(context);

    const beforeRun = firstHook(hooks, 'beforeRun');
    const beforeLLMCall = firstHook(hooks, 'beforeLLMCall');

    await beforeRun({
      context: { messages: [] },
      tools: {},
      runContext: {
        callerSelectors: ['discord:thread'],
      },
    });

    const execute = vi.fn(async () => 'ok');
    const tools: Record<string, Tool> = {
      guarded_tool: {
        name: 'guarded_tool',
        description: 'guarded',
        inputSchema: {} as never,
        allowed_callers: ['discord:thread'],
        execute,
      },
    };

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools,
      systemPrompt: undefined,
    });

    const guardedTool = result?.tools?.guarded_tool;
    expect(guardedTool).toBeDefined();

    await expect(
      guardedTool!.execute({}, {
        runContext: {
          callerSelectors: ['feishu:group'],
        },
      }),
    ).rejects.toThrow('[PTC] Tool "guarded_tool" is not allowed for the current caller.');

    expect(execute).not.toHaveBeenCalled();
  });

  it('supports wildcard allowed_callers', async () => {
    const { context, hooks } = createPluginContext();
    await builtInPtcPlugin.initialize(context);

    const beforeRun = firstHook(hooks, 'beforeRun');
    const beforeLLMCall = firstHook(hooks, 'beforeLLMCall');

    await beforeRun({
      context: { messages: [] },
      tools: {},
      runContext: undefined,
    });

    const execute = vi.fn(async () => 'ok');
    const tools: Record<string, Tool> = {
      wildcard_tool: {
        name: 'wildcard_tool',
        description: 'wildcard',
        inputSchema: {} as never,
        allowed_callers: ['*'],
        execute,
      },
    };

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools,
      systemPrompt: undefined,
    });

    expect(result?.tools?.wildcard_tool).toBeDefined();
    await expect(result!.tools!.wildcard_tool.execute({}, { runContext: {} })).resolves.toBe('ok');
  });
});

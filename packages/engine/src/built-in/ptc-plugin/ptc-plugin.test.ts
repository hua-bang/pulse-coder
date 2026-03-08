import { describe, it, expect } from 'vitest';
import type { Tool } from '../../shared/types';
import { Engine } from '../../Engine';
import { builtInPtcPlugin } from './ptc-plugin.js';

const createNoopTool = (name: string, allowed_callers?: string[]): Tool<any, any> => ({
  name,
  description: `${name} test tool`,
  inputSchema: { parse: (value: any) => value },
  allowed_callers,
  execute: async () => ({ ok: true, name }),
});

describe('builtInPtcPlugin', () => {
  it('filters tools by allowed_callers using runContext.callerSelectors', async () => {
    const plugin = {
      ...builtInPtcPlugin,
      version: `${builtInPtcPlugin.version}-test-filter`,
    };

    const engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [plugin],
      },
      tools: {
        open_tool: createNoopTool('open_tool'),
        restricted_tool: createNoopTool('restricted_tool', ['ptc_demo_caller_probe']),
      },
    });

    await engine.initialize();

    const beforeRun = (engine as any).pluginManager.getHooks('beforeRun')[0];
    const beforeLLMCall = (engine as any).pluginManager.getHooks('beforeLLMCall')[0];

    expect(beforeRun).toBeTypeOf('function');
    expect(beforeLLMCall).toBeTypeOf('function');

    await beforeRun({
      context: { messages: [] },
      tools: engine.getTools(),
      runContext: {
        callerSelectors: ['ptc_demo_caller_probe'],
      },
    });

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools: engine.getTools(),
    });

    expect(result?.tools).toBeDefined();
    expect(Object.keys(result.tools)).toContain('open_tool');
    expect(Object.keys(result.tools)).toContain('restricted_tool');

    await beforeRun({
      context: { messages: [] },
      tools: engine.getTools(),
      runContext: {
        callerSelectors: ['some_other_tool'],
      },
    });

    const blockedResult = await beforeLLMCall({
      context: { messages: [] },
      tools: engine.getTools(),
    });

    expect(Object.keys(blockedResult.tools)).toContain('open_tool');
    expect(Object.keys(blockedResult.tools)).not.toContain('restricted_tool');
  });

  it('supports runContext.caller fallback for selector matching', async () => {
    const plugin = {
      ...builtInPtcPlugin,
      version: `${builtInPtcPlugin.version}-test-caller-fallback`,
    };

    const engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [plugin],
      },
      tools: {
        fallback_tool: createNoopTool('fallback_tool', ['cron_job']),
      },
    });

    await engine.initialize();

    const beforeRun = (engine as any).pluginManager.getHooks('beforeRun')[0];
    const beforeLLMCall = (engine as any).pluginManager.getHooks('beforeLLMCall')[0];

    await beforeRun({
      context: { messages: [] },
      tools: engine.getTools(),
      runContext: {
        caller: 'cron_job',
      },
    });

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools: engine.getTools(),
    });

    expect(Object.keys(result.tools)).toContain('fallback_tool');
  });

  it('blocks runtime execution when execution runContext does not match allowed_callers', async () => {
    const plugin = {
      ...builtInPtcPlugin,
      version: `${builtInPtcPlugin.version}-test-runtime-enforce`,
    };

    const engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [plugin],
      },
      tools: {
        guarded_tool: createNoopTool('guarded_tool', ['ptc_demo_caller_probe']),
      },
    });

    await engine.initialize();

    const beforeRun = (engine as any).pluginManager.getHooks('beforeRun')[0];
    const beforeLLMCall = (engine as any).pluginManager.getHooks('beforeLLMCall')[0];

    await beforeRun({
      context: { messages: [] },
      tools: engine.getTools(),
      runContext: {
        callerSelectors: ['ptc_demo_caller_probe'],
      },
    });

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools: engine.getTools(),
    });

    await expect(
      result.tools.guarded_tool.execute({}, {
        runContext: {
          callerSelectors: ['other_tool'],
        },
      }),
    ).rejects.toThrow('[PTC] Tool "guarded_tool" is not allowed for the current caller.');
  });

  it('supports wildcard allowed_callers', async () => {
    const plugin = {
      ...builtInPtcPlugin,
      version: `${builtInPtcPlugin.version}-test-wildcard`,
    };

    const engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [plugin],
      },
      tools: {
        wildcard_tool: createNoopTool('wildcard_tool', ['*']),
      },
    });

    await engine.initialize();

    const beforeRun = (engine as any).pluginManager.getHooks('beforeRun')[0];
    const beforeLLMCall = (engine as any).pluginManager.getHooks('beforeLLMCall')[0];

    await beforeRun({
      context: { messages: [] },
      tools: engine.getTools(),
      runContext: {
        callerSelectors: ['unrelated_tool'],
      },
    });

    const result = await beforeLLMCall({
      context: { messages: [] },
      tools: engine.getTools(),
    });

    expect(Object.keys(result.tools)).toContain('wildcard_tool');
  });
});

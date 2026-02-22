import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemPromptOption } from 'pulse-coder-engine';
import { createMemoryEnginePlugin, type MemoryRunContext } from './integration.js';
import { FileMemoryPluginService } from './service.js';

const createdDirs: string[] = [];

async function createService() {
  const baseDir = await mkdtemp(join(tmpdir(), 'memory-plugin-integration-test-'));
  createdDirs.push(baseDir);

  const service = new FileMemoryPluginService({ baseDir });
  await service.initialize();
  return { baseDir, service };
}

function resolveSystemPrompt(option: SystemPromptOption | undefined): string {
  if (!option) {
    return '';
  }

  if (typeof option === 'string') {
    return option;
  }

  if (typeof option === 'function') {
    return option();
  }

  return option.append;
}

function createPluginContextMock() {
  const hooks: Record<string, Array<(input: any) => Promise<any>>> = {};

  return {
    hooks,
    context: {
      registerTool: () => {},
      registerTools: () => {},
      getTool: () => undefined,
      getTools: () => ({}),
      registerHook: (name: string, handler: (input: any) => Promise<any>) => {
        hooks[name] = hooks[name] ?? [];
        hooks[name].push(handler);
      },
      registerService: () => {},
      getService: () => undefined,
      getConfig: () => undefined,
      setConfig: () => {},
      events: new EventEmitter(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('memory-plugin beforeRun auto injection', () => {
  it('injects user-scope profile/rule memory into system prompt each run', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-a',
      userText: 'Profile: my name is Jasper.',
      assistantText: 'Profile captured.',
      sourceType: 'explicit',
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-a',
      userText: 'Rule: must keep responses concise.',
      assistantText: 'Acknowledged.',
      sourceType: 'explicit',
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-a',
      userText: 'Remember this preference for later: use emoji in status updates.',
      assistantText: 'Noted.',
      sourceType: 'explicit',
    });

    let runContext: MemoryRunContext | undefined = {
      platformKey: 'test-platform',
      sessionId: 'session-b',
      userText: 'continue',
    };

    const plugin = createMemoryEnginePlugin({
      service,
      getRunContext: () => runContext,
    });

    const mock = createPluginContextMock();
    await plugin.initialize(mock.context as any);

    const beforeRun = mock.hooks.beforeRun?.[0];
    expect(beforeRun).toBeDefined();

    const result = await beforeRun({
      context: { messages: [] },
      systemPrompt: undefined,
      tools: {},
    });

    const prompt = resolveSystemPrompt(result?.systemPrompt);
    expect(prompt).toContain('Memory Tool Policy (On-Demand)');
    expect(prompt).toContain('Persistent user memory (auto-injected each run');
    expect(prompt).toContain('my name is Jasper');
    expect(prompt).toContain('must keep responses concise');
    expect(prompt).not.toContain('use emoji in status updates');

    runContext = undefined;
  });

  it('keeps policy append when run context is unavailable', async () => {
    const { service } = await createService();

    const plugin = createMemoryEnginePlugin({
      service,
      getRunContext: () => undefined,
    });

    const mock = createPluginContextMock();
    await plugin.initialize(mock.context as any);

    const beforeRun = mock.hooks.beforeRun?.[0];
    const result = await beforeRun({
      context: { messages: [] },
      systemPrompt: undefined,
      tools: {},
    });

    const prompt = resolveSystemPrompt(result?.systemPrompt);
    expect(prompt).toContain('Memory Tool Policy (On-Demand)');
    expect(prompt).not.toContain('Persistent user memory (auto-injected each run');
  });
});

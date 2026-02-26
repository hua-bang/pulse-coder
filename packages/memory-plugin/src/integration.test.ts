import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelMessage, SystemPromptOption } from 'pulse-coder-engine';
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

describe('memory-plugin compaction write hook', () => {
  it('writes one daily-log turn from removed compaction messages', async () => {
    const { service } = await createService();

    const runContext: MemoryRunContext = {
      platformKey: 'test-platform',
      sessionId: 'session-compaction',
      userText: 'continue',
    };

    const plugin = createMemoryEnginePlugin({
      service,
      getRunContext: () => runContext,
      compactionWritePolicy: {
        enabled: true,
        minTokenDelta: 500,
        minRemovedMessages: 2,
        maxPerRun: 1,
      },
    });

    const mock = createPluginContextMock();
    await plugin.initialize(mock.context as any);

    const beforeRun = mock.hooks.beforeRun?.[1];
    const onCompacted = mock.hooks.onCompacted?.[0];
    expect(beforeRun).toBeDefined();
    expect(onCompacted).toBeDefined();

    await beforeRun({
      context: { messages: [] },
      tools: {},
      systemPrompt: undefined,
    });

    const previousMessages: ModelMessage[] = [
      { role: 'user', content: 'Rule: must keep migration docs in each release ticket.' },
      { role: 'assistant', content: 'Decision: we will enforce migration docs in PR checklist.' },
      { role: 'user', content: 'Proceed with implementation.' },
    ];

    const newMessages: ModelMessage[] = [
      { role: 'assistant', content: '[COMPACTED_CONTEXT]\nsummary' },
      { role: 'user', content: 'Proceed with implementation.' },
    ];

    await onCompacted({
      context: { messages: newMessages },
      previousMessages,
      newMessages,
      event: {
        attempt: 1,
        trigger: 'pre-loop',
        forced: false,
        beforeMessageCount: previousMessages.length,
        afterMessageCount: newMessages.length,
        beforeEstimatedTokens: 12000,
        afterEstimatedTokens: 2000,
        strategy: 'summary',
      },
    });

    const listed = await service.list({
      platformKey: runContext.platformKey,
      sessionId: runContext.sessionId,
      limit: 10,
    });

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.sourceType === 'daily-log')).toBe(true);
    expect(listed.some((item) => item.content.toLowerCase().includes('migration docs'))).toBe(true);
  });

  it('respects maxPerRun by skipping second compaction write in same run', async () => {
    const { service } = await createService();

    const runContext: MemoryRunContext = {
      platformKey: 'test-platform',
      sessionId: 'session-compaction-quota',
      userText: 'continue',
    };

    const plugin = createMemoryEnginePlugin({
      service,
      getRunContext: () => runContext,
      compactionWritePolicy: {
        enabled: true,
        minTokenDelta: 200,
        minRemovedMessages: 1,
        maxPerRun: 1,
      },
    });

    const mock = createPluginContextMock();
    await plugin.initialize(mock.context as any);

    const beforeRun = mock.hooks.beforeRun?.[1];
    const onCompacted = mock.hooks.onCompacted?.[0];
    expect(beforeRun).toBeDefined();
    expect(onCompacted).toBeDefined();

    await beforeRun({
      context: { messages: [] },
      tools: {},
      systemPrompt: undefined,
    });

    const firstPrev: ModelMessage[] = [
      { role: 'user', content: 'Rule: must run smoke tests before deploy.' },
      { role: 'assistant', content: 'Acknowledged.' },
    ];
    const firstNew: ModelMessage[] = [
      { role: 'assistant', content: '[COMPACTED_CONTEXT]\nsummary1' },
    ];

    const secondPrev: ModelMessage[] = [
      { role: 'user', content: 'Rule: must annotate risky migrations.' },
      { role: 'assistant', content: 'Acknowledged.' },
    ];
    const secondNew: ModelMessage[] = [
      { role: 'assistant', content: '[COMPACTED_CONTEXT]\nsummary2' },
    ];

    const event = {
      attempt: 1,
      trigger: 'pre-loop' as const,
      forced: false,
      beforeMessageCount: 2,
      afterMessageCount: 1,
      beforeEstimatedTokens: 1000,
      afterEstimatedTokens: 100,
      strategy: 'summary' as const,
    };

    await onCompacted({
      context: { messages: firstNew },
      previousMessages: firstPrev,
      newMessages: firstNew,
      event,
    });

    await onCompacted({
      context: { messages: secondNew },
      previousMessages: secondPrev,
      newMessages: secondNew,
      event,
    });

    const listed = await service.list({
      platformKey: runContext.platformKey,
      sessionId: runContext.sessionId,
      limit: 20,
    });

    expect(listed.length).toBeGreaterThan(0);
    const uniqueNormalized = new Set(listed.map((item) => item.content.toLowerCase().trim()));
    expect(uniqueNormalized.size).toBe(1);
  });
});

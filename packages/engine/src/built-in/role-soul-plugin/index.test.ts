import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { Tool } from '../../shared/types.js';
import { builtInRoleSoulPlugin } from './index.js';

function createPluginContextHarness(): {
  context: EnginePluginContext;
  tools: Record<string, Tool<any, any>>;
} {
  const tools: Record<string, Tool<any, any>> = {};
  const services = new Map<string, any>();
  const configs = new Map<string, any>();
  const hooks = new Map<string, Array<(input: any) => Promise<any>>>();

  const context: EnginePluginContext = {
    registerTool: (name: string, tool: any) => {
      tools[name] = tool;
    },
    registerTools: (nextTools: Record<string, any>) => {
      Object.assign(tools, nextTools);
    },
    getTool: (name: string) => tools[name],
    getTools: () => ({ ...tools }),
    getEngineInstance: () => ({}) as any,
    registerHook: (hookName: any, handler: any) => {
      const current = hooks.get(hookName) ?? [];
      current.push(handler);
      hooks.set(hookName, current);
    },
    registerService: <T>(name: string, service: T) => {
      services.set(name, service);
    },
    getService: <T>(name: string) => services.get(name) as T | undefined,
    getConfig: <T>(key: string) => configs.get(key) as T | undefined,
    setConfig: <T>(key: string, value: T) => {
      configs.set(key, value);
    },
    events: new EventEmitter(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  return { context, tools };
}

describe('builtInRoleSoulPlugin runtime registration persistence', () => {
  let tempDir = '';
  let originalStateDir: string | undefined;
  let originalRegistryPath: string | undefined;
  let originalPersist: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'pulse-coder-soul-runtime-'));

    originalStateDir = process.env.PULSE_CODER_SOUL_STATE_DIR;
    originalRegistryPath = process.env.PULSE_CODER_SOUL_REGISTRY_PATH;
    originalPersist = process.env.PULSE_CODER_SOUL_PERSIST;

    process.env.PULSE_CODER_SOUL_STATE_DIR = path.join(tempDir, 'state');
    process.env.PULSE_CODER_SOUL_REGISTRY_PATH = path.join(tempDir, 'runtime-registry.json');
    process.env.PULSE_CODER_SOUL_PERSIST = '1';
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.PULSE_CODER_SOUL_STATE_DIR;
    } else {
      process.env.PULSE_CODER_SOUL_STATE_DIR = originalStateDir;
    }

    if (originalRegistryPath === undefined) {
      delete process.env.PULSE_CODER_SOUL_REGISTRY_PATH;
    } else {
      process.env.PULSE_CODER_SOUL_REGISTRY_PATH = originalRegistryPath;
    }

    if (originalPersist === undefined) {
      delete process.env.PULSE_CODER_SOUL_PERSIST;
    } else {
      process.env.PULSE_CODER_SOUL_PERSIST = originalPersist;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists registered souls across plugin re-initialization', async () => {
    const soulId = '__vitest_runtime_persisted_soul__';

    const firstHarness = createPluginContextHarness();
    await builtInRoleSoulPlugin.initialize(firstHarness.context);

    await firstHarness.tools.soul_register.execute({
      id: soulId,
      name: 'Runtime Persisted Soul',
      prompt: 'Stay grounded and evidence-based.',
    });

    const secondHarness = createPluginContextHarness();
    await builtInRoleSoulPlugin.initialize(secondHarness.context);

    const soulList = await secondHarness.tools.soul_list.execute({ format: 'full' }) as Array<Record<string, any>>;
    const persistedSoul = soulList.find((item) => item.id === soulId);

    expect(persistedSoul).toBeDefined();
    expect(persistedSoul?.location).toBe('runtime');
  });

  it('keeps registered souls after soul_clear removes active session state', async () => {
    const soulId = '__vitest_runtime_clear_keeps_registry__';
    const sessionId = 'session-clear-keeps-registry';

    const harness = createPluginContextHarness();
    await builtInRoleSoulPlugin.initialize(harness.context);

    await harness.tools.soul_register.execute({
      id: soulId,
      name: 'Clear Keeps Registry',
      prompt: 'Clear active state but keep registration.',
    });

    await harness.tools.soul_use.execute({ sessionId, soulId });
    const beforeClear = await harness.tools.soul_status.execute({ sessionId }) as { state?: { activeSoulIds?: string[] } };
    expect(beforeClear.state?.activeSoulIds).toContain(soulId);

    await harness.tools.soul_clear.execute({ sessionId });

    const afterClear = await harness.tools.soul_status.execute({ sessionId }) as { state?: { activeSoulIds?: string[] } };
    expect(afterClear.state?.activeSoulIds ?? []).toEqual([]);

    const soulList = await harness.tools.soul_list.execute({ format: 'summary' }) as Array<{ id: string }>;
    expect(soulList.some((item) => item.id === soulId)).toBe(true);
  });
});

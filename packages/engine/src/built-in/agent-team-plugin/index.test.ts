import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { builtInAgentTeamPlugin } from './index.js';
import type { EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { Tool } from '../../shared/types.js';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
});

type MutableContext = EnginePluginContext & {
  _tools: Record<string, Tool>;
  _services: Map<string, unknown>;
};

function createContext(): MutableContext {
  const tools: Record<string, Tool> = {};
  const services = new Map<string, unknown>();
  const config = new Map<string, unknown>();

  const context: MutableContext = {
    _tools: tools,
    _services: services,
    registerTool: (name, tool) => {
      tools[name] = tool;
    },
    registerTools: (entries) => {
      for (const [name, tool] of Object.entries(entries)) {
        tools[name] = tool as Tool;
      }
    },
    getTool: (name) => tools[name],
    getTools: () => ({ ...tools }),
    registerHook: () => undefined,
    registerService: (name, service) => {
      services.set(name, service);
    },
    getService: (name) => services.get(name) as any,
    getConfig: (key) => config.get(key) as any,
    setConfig: (key, value) => {
      config.set(key, value);
    },
    events: { on: vi.fn(), emit: vi.fn() } as any,
    logger: createLogger()
  };

  return context;
}

async function writeTeamSpec(baseDir: string, fileName: string, payload: unknown): Promise<void> {
  const dir = path.join(baseDir, '.pulse-coder', 'teams');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), JSON.stringify(payload, null, 2), 'utf8');
}

describe('builtInAgentTeamPlugin', () => {
  let sandboxDir = '';

  beforeEach(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'pulse-coder-agent-team-'));
    vi.spyOn(process, 'cwd').mockReturnValue(sandboxDir);
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads team specs and executes DAG waves through team_run', async () => {
    await writeTeamSpec(sandboxDir, 'code-delivery-l2.team.json', {
      teamId: 'code-delivery-l2',
      version: '1.0.0',
      maxParallel: 2,
      nodes: [
        {
          id: 'analyze',
          agent: 'doc-generator',
          goalTemplate: 'Analyze {{goal}} with {{input.topic}}',
          deps: []
        },
        {
          id: 'review',
          agent: 'code-reviewer',
          goalTemplate: 'Review {{deps.analyze.output}}',
          deps: ['analyze']
        }
      ],
      finalAggregator: {
        mode: 'template',
        template: 'Review: {{nodes.review.output}}'
      }
    });

    const context = createContext();
    const docAgent = vi.fn(async ({ task }: { task: string }) => `doc:${task}`);
    const reviewAgent = vi.fn(async ({ task }: { task: string }) => `review:${task}`);

    context.registerTool('doc-generator_agent', {
      name: 'doc-generator_agent',
      description: 'doc agent',
      inputSchema: {} as any,
      execute: docAgent
    });

    context.registerTool('code-reviewer_agent', {
      name: 'code-reviewer_agent',
      description: 'review agent',
      inputSchema: {} as any,
      execute: reviewAgent
    });

    await builtInAgentTeamPlugin.initialize(context);

    const teamRun = context.getTool('team_run') as Tool;
    expect(teamRun).toBeTruthy();

    const result = await teamRun.execute({
      teamId: 'code-delivery-l2',
      goal: 'Ship feature',
      input: { topic: 'auth' }
    });

    expect(docAgent).toHaveBeenCalledTimes(1);
    expect(reviewAgent).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    expect(result.finalText).toContain('review:Review doc:Analyze Ship feature with auth');
    expect(result.trace).toHaveLength(2);

    const registry = context.getService<any>('agent-team:registry');
    expect(registry).toBeTruthy();
    expect(registry.list()).toEqual([
      expect.objectContaining({
        teamId: 'code-delivery-l2',
        nodeCount: 2
      })
    ]);
  });

  it('fails fast for missing team ids', async () => {
    const context = createContext();
    await builtInAgentTeamPlugin.initialize(context);

    const teamRun = context.getTool('team_run') as Tool;

    await expect(teamRun.execute({
      teamId: 'missing-team',
      goal: 'anything'
    } as any)).rejects.toThrow('teamId "missing-team" not found');
  });
});


import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import { globSync } from 'glob';
import { z } from 'zod';

import { loop } from '../../core/loop.js';
import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { Context, Tool, ToolExecutionContext } from '../../shared/types.js';

type L2NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

interface L2NodeSpec {
  id: string;
  agent: string;
  goalTemplate: string;
  deps: string[];
  timeoutMs: number;
  retries: number;
  optional: boolean;
}

interface L2FinalAggregatorSpec {
  mode: 'template' | 'llm';
  template?: string;
  systemPrompt?: string;
}

interface L2TeamSpec {
  teamId: string;
  version: string;
  maxParallel: number;
  nodes: L2NodeSpec[];
  finalAggregator: L2FinalAggregatorSpec;
  sourcePath: string;
}

interface L2NodeResult {
  id: string;
  agent: string;
  status: L2NodeStatus;
  output?: unknown;
  error?: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
}

interface L2RunResult {
  runId: string;
  teamId: string;
  status: 'success' | 'failed';
  finalText: string;
  failedNodeCount: number;
  skippedNodeCount: number;
  trace: L2NodeResult[];
}

interface TeamRegistryService {
  get(teamId: string): L2TeamSpec | undefined;
  list(): Array<{ teamId: string; version: string; nodeCount: number; sourcePath: string }>;
  reload(): number;
}

const DEFAULT_MAX_PARALLEL = 3;
const MAX_PARALLEL_LIMIT = 20;
const DEFAULT_NODE_TIMEOUT_MS = 120_000;

const teamRunSchema = z.object({
  teamId: z.string().min(1).describe('Team ID from .pulse-coder/teams/*.team.json'),
  goal: z.string().min(1).describe('Top-level user goal for this team run'),
  input: z.record(z.string(), z.unknown()).optional().describe('Structured input payload for node templates'),
  maxParallel: z.number().int().positive().max(MAX_PARALLEL_LIMIT).optional().describe('Override max parallelism for this run')
});

type TeamRunInput = z.infer<typeof teamRunSchema>;

function clampMaxParallel(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  return Math.max(1, Math.min(MAX_PARALLEL_LIMIT, candidate));
}

function normalizeNodeSpec(raw: Record<string, unknown>, teamId: string): L2NodeSpec | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
  const goalTemplate = typeof raw.goalTemplate === 'string' ? raw.goalTemplate : '';
  if (!id || !agent || !goalTemplate) {
    console.warn(`[L2Team] Invalid node in team ${teamId}, missing id/agent/goalTemplate`);
    return null;
  }

  const deps = Array.isArray(raw.deps)
    ? Array.from(new Set(raw.deps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
    : [];

  const retries = Number.isInteger(raw.retries) ? Number(raw.retries) : 0;
  const timeoutMs = Number.isInteger(raw.timeoutMs) ? Number(raw.timeoutMs) : DEFAULT_NODE_TIMEOUT_MS;

  return {
    id,
    agent,
    goalTemplate,
    deps,
    retries: Math.max(0, retries),
    timeoutMs: Math.max(1_000, timeoutMs),
    optional: raw.optional === true
  };
}

function normalizeTeamSpec(raw: unknown, sourcePath: string): L2TeamSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : '';
  const version = typeof data.version === 'string' ? data.version.trim() : '1.0.0';

  if (!teamId) {
    console.warn(`[L2Team] teamId is required in ${sourcePath}`);
    return null;
  }

  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    console.warn(`[L2Team] nodes are required in ${sourcePath}`);
    return null;
  }

  const nodes: L2NodeSpec[] = [];
  for (const item of data.nodes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const node = normalizeNodeSpec(item as Record<string, unknown>, teamId);
    if (node) {
      nodes.push(node);
    }
  }

  if (nodes.length === 0) {
    console.warn(`[L2Team] no valid nodes in ${sourcePath}`);
    return null;
  }

  const finalAggregatorRaw = data.finalAggregator;
  const finalAggregator: L2FinalAggregatorSpec = {
    mode: 'template'
  };

  if (finalAggregatorRaw && typeof finalAggregatorRaw === 'object' && !Array.isArray(finalAggregatorRaw)) {
    const mode = (finalAggregatorRaw as Record<string, unknown>).mode;
    const template = (finalAggregatorRaw as Record<string, unknown>).template;
    const systemPrompt = (finalAggregatorRaw as Record<string, unknown>).systemPrompt;
    if (mode === 'template' || mode === 'llm') {
      finalAggregator.mode = mode;
    }
    if (typeof template === 'string') {
      finalAggregator.template = template;
    }
    if (typeof systemPrompt === 'string') {
      finalAggregator.systemPrompt = systemPrompt;
    }
  }

  const maxParallelRaw = data.maxParallel;
  const maxParallel = Number.isInteger(maxParallelRaw)
    ? clampMaxParallel(Number(maxParallelRaw), DEFAULT_MAX_PARALLEL)
    : DEFAULT_MAX_PARALLEL;

  return {
    teamId,
    version,
    maxParallel,
    nodes,
    finalAggregator,
    sourcePath
  };
}

function validateGraph(spec: L2TeamSpec): void {
  const idSet = new Set<string>();
  for (const node of spec.nodes) {
    if (idSet.has(node.id)) {
      throw new Error(`[L2Team] Duplicate node id "${node.id}" in team "${spec.teamId}"`);
    }
    idSet.add(node.id);
  }

  for (const node of spec.nodes) {
    for (const dep of node.deps) {
      if (!idSet.has(dep)) {
        throw new Error(`[L2Team] Node "${node.id}" depends on missing node "${dep}" in team "${spec.teamId}"`);
      }
      if (dep === node.id) {
        throw new Error(`[L2Team] Node "${node.id}" cannot depend on itself`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of spec.nodes) {
    inDegree.set(node.id, node.deps.length);
    adjacency.set(node.id, []);
  }
  for (const node of spec.nodes) {
    for (const dep of node.deps) {
      adjacency.get(dep)?.push(node.id);
    }
  }

  const queue: string[] = Array.from(inDegree.entries()).filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited += 1;
    for (const next of adjacency.get(id) ?? []) {
      const degree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== spec.nodes.length) {
    throw new Error(`[L2Team] Team "${spec.teamId}" contains a cycle`);
  }
}

function safeToString(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getValueByPath(source: unknown, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }
  const parts = pathExpr.split('.').filter(Boolean);
  let cursor: unknown = source;

  for (const key of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return cursor;
}

function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_raw, token) => {
    const value = getValueByPath(input, String(token));
    return safeToString(value);
  });
}

function teamScanPaths(cwd: string): string[] {
  return [
    path.join(homedir(), '.pulse-coder', 'teams'),
    path.join(homedir(), '.coder', 'teams'),
    path.join(cwd, '.coder', 'teams'),
    path.join(cwd, '.pulse-coder', 'teams')
  ];
}

class L2TeamRegistry implements TeamRegistryService {
  private readonly specs = new Map<string, L2TeamSpec>();

  constructor(private readonly cwd: string) {
    this.reload();
  }

  get(teamId: string): L2TeamSpec | undefined {
    return this.specs.get(teamId);
  }

  list(): Array<{ teamId: string; version: string; nodeCount: number; sourcePath: string }> {
    return Array.from(this.specs.values()).map((spec) => ({
      teamId: spec.teamId,
      version: spec.version,
      nodeCount: spec.nodes.length,
      sourcePath: spec.sourcePath
    }));
  }

  reload(): number {
    this.specs.clear();

    for (const basePath of teamScanPaths(this.cwd)) {
      if (!existsSync(basePath)) {
        continue;
      }
      const files = globSync('*.team.json', { cwd: basePath, absolute: true });
      for (const filePath of files) {
        try {
          const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
          const spec = normalizeTeamSpec(parsed, filePath);
          if (!spec) {
            continue;
          }
          validateGraph(spec);
          this.specs.set(spec.teamId, spec);
        } catch (error) {
          console.warn(`[L2Team] Failed to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return this.specs.size;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function resolveAgentToolName(agent: string): string {
  const trimmed = agent.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === 'team_run') {
    throw new Error('team_run cannot be used as a node agent');
  }
  if (trimmed.endsWith('_agent')) {
    return trimmed;
  }
  return `${trimmed}_agent`;
}

async function aggregateFinalText(
  spec: L2TeamSpec,
  goal: string,
  runInput: Record<string, unknown>,
  trace: L2NodeResult[]
): Promise<string> {
  const nodeMap = Object.fromEntries(
    trace.map((item) => [item.id, {
      status: item.status,
      output: item.output,
      error: item.error,
      attempts: item.attempts
    }])
  );

  if (spec.finalAggregator.mode === 'llm') {
    const systemPrompt = spec.finalAggregator.systemPrompt
      ?? 'You aggregate multi-agent execution traces. Return a concise, clear final answer.';

    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [
            `Goal: ${goal}`,
            `Input: ${safeToString(runInput)}`,
            `Trace: ${safeToString(nodeMap)}`,
            'Produce the final response in plain text and include key findings first.'
          ].join('\n\n')
        }
      ]
    };

    try {
      return await loop(context, { tools: {}, systemPrompt });
    } catch {
      // Fall through to deterministic summary.
    }
  }

  if (spec.finalAggregator.template) {
    return renderTemplate(spec.finalAggregator.template, {
      goal,
      input: runInput,
      nodes: nodeMap
    });
  }

  const lines = [`Team ${spec.teamId} finished goal: ${goal}`];
  for (const item of trace) {
    lines.push(`- [${item.status}] ${item.id} via ${item.agent}`);
    if (item.output !== undefined) {
      lines.push(`  output: ${safeToString(item.output)}`);
    }
    if (item.error) {
      lines.push(`  error: ${item.error}`);
    }
  }

  return lines.join('\n');
}

async function executeNode(
  node: L2NodeSpec,
  states: Map<string, L2NodeResult>,
  tools: Record<string, Tool>,
  runInput: TeamRunInput,
  toolExecutionContext?: ToolExecutionContext
): Promise<L2NodeResult> {
  const state = states.get(node.id);
  if (!state) {
    throw new Error(`Missing node state for ${node.id}`);
  }

  const depsContext = Object.fromEntries(
    node.deps.map((depId) => [depId, {
      status: states.get(depId)?.status,
      output: states.get(depId)?.output,
      error: states.get(depId)?.error
    }])
  );

  const task = renderTemplate(node.goalTemplate, {
    goal: runInput.goal,
    input: runInput.input ?? {},
    deps: depsContext,
    node: {
      id: node.id,
      agent: node.agent
    }
  });

  const agentToolName = resolveAgentToolName(node.agent);
  const tool = tools[agentToolName] as Tool<{ task: string; context?: Record<string, unknown> }, unknown> | undefined;
  if (!tool?.execute) {
    throw new Error(`Agent tool "${agentToolName}" is not available`);
  }

  let attempts = 0;
  let lastError: Error | null = null;
  while (attempts <= node.retries) {
    attempts += 1;

    try {
      const runPromise = Promise.resolve(tool.execute({
        task,
        context: {
          goal: runInput.goal,
          input: runInput.input ?? {},
          deps: depsContext,
          nodeId: node.id,
          attempt: attempts
        }
      }, toolExecutionContext));

      const output = await withTimeout(runPromise, node.timeoutMs, `node:${node.id}`);
      state.status = 'success';
      state.output = output;
      state.error = undefined;
      state.attempts = attempts;
      return state;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      state.attempts = attempts;
      if (attempts <= node.retries) {
        continue;
      }
    }
  }

  if (node.optional) {
    state.status = 'skipped';
  } else {
    state.status = 'failed';
  }
  state.error = lastError?.message ?? 'Unknown node failure';
  return state;
}

function markBlockedNodes(spec: L2TeamSpec, states: Map<string, L2NodeResult>): number {
  let changed = 0;

  for (const node of spec.nodes) {
    const state = states.get(node.id);
    if (!state || state.status !== 'pending') {
      continue;
    }

    const failedDep = node.deps.find((depId) => states.get(depId)?.status === 'failed');
    if (!failedDep) {
      continue;
    }

    state.status = 'skipped';
    state.error = `blocked by failed dependency: ${failedDep}`;
    changed += 1;
  }

  return changed;
}

function pickReadyNodes(spec: L2TeamSpec, states: Map<string, L2NodeResult>): L2NodeSpec[] {
  return spec.nodes.filter((node) => {
    const state = states.get(node.id);
    if (!state || state.status !== 'pending') {
      return false;
    }

    return node.deps.every((depId) => {
      const depStatus = states.get(depId)?.status;
      return depStatus === 'success' || depStatus === 'skipped';
    });
  });
}

async function runTeam(
  spec: L2TeamSpec,
  input: TeamRunInput,
  tools: Record<string, Tool>,
  toolExecutionContext?: ToolExecutionContext
): Promise<L2RunResult> {
  const runId = randomUUID();
  const maxParallel = clampMaxParallel(input.maxParallel, spec.maxParallel);

  const states = new Map<string, L2NodeResult>();
  for (const node of spec.nodes) {
    states.set(node.id, {
      id: node.id,
      agent: node.agent,
      status: 'pending',
      attempts: 0
    });
  }

  let hardFailed = false;

  while (true) {
    markBlockedNodes(spec, states);

    const pendingCount = Array.from(states.values()).filter((state) => state.status === 'pending').length;
    if (pendingCount === 0) {
      break;
    }

    const readyNodes = pickReadyNodes(spec, states);
    if (readyNodes.length === 0) {
      hardFailed = true;
      break;
    }

    const waves = chunk(readyNodes, maxParallel);
    for (const wave of waves) {
      const promises = wave.map(async (node) => {
        const state = states.get(node.id);
        if (!state) {
          return;
        }
        state.status = 'running';
        state.startedAt = Date.now();
        const result = await executeNode(node, states, tools, input, toolExecutionContext);
        result.endedAt = Date.now();
        states.set(node.id, result);
      });

      await Promise.all(promises);

      const failedCriticalNode = wave.find((node) => {
        const state = states.get(node.id);
        return state?.status === 'failed' && !node.optional;
      });

      if (failedCriticalNode) {
        hardFailed = true;
        break;
      }
    }

    if (hardFailed) {
      break;
    }
  }

  const trace = spec.nodes.map((node) => {
    const state = states.get(node.id);
    if (!state) {
      return {
        id: node.id,
        agent: node.agent,
        status: 'skipped',
        error: 'state_not_found',
        attempts: 0
      } satisfies L2NodeResult;
    }
    return state;
  });

  const failedNodeCount = trace.filter((item) => item.status === 'failed').length;
  const skippedNodeCount = trace.filter((item) => item.status === 'skipped').length;

  const finalText = await aggregateFinalText(spec, input.goal, input.input ?? {}, trace);

  return {
    runId,
    teamId: spec.teamId,
    status: failedNodeCount > 0 || hardFailed ? 'failed' : 'success',
    finalText,
    failedNodeCount,
    skippedNodeCount,
    trace
  };
}

export const builtInL2TeamPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-l2-team',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const registry = new L2TeamRegistry(process.cwd());

    context.registerService<TeamRegistryService>('l2-team:registry', registry);

    const teamRunTool: Tool<TeamRunInput, L2RunResult> = {
      name: 'team_run',
      description: [
        'Run a fixed-role L2 agent team with DAG scheduling.',
        'Team specs are loaded from .pulse-coder/teams/*.team.json (also supports .coder/teams).',
        'Each node maps to an agent tool (e.g. code-reviewer_agent).',
      ].join(' '),
      inputSchema: teamRunSchema,
      execute: async (rawInput, toolExecutionContext) => {
        const input = teamRunSchema.parse(rawInput);
        const spec = registry.get(input.teamId);
        if (!spec) {
          const available = registry.list().map((item) => item.teamId);
          throw new Error(`teamId "${input.teamId}" not found. Available: ${available.join(', ') || 'none'}`);
        }

        const allTools = context.getTools() as Record<string, Tool>;
        return await runTeam(spec, input, allTools, toolExecutionContext);
      }
    };

    context.registerTool(teamRunTool.name, teamRunTool);
    context.logger.info(`[L2Team] Loaded ${registry.list().length} team specs`);
  }
};

export default builtInL2TeamPlugin;

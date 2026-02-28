import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import { globSync } from 'glob';

import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_NODE_TIMEOUT_MS,
  MAX_PARALLEL_LIMIT
} from './constants.js';
import type {
  AgentTeamFinalAggregatorSpec,
  AgentTeamNodeSpec,
  AgentTeamRegistryService,
  AgentTeamRegistrySummary,
  AgentTeamSpec
} from './types.js';
import { clampMaxParallel } from './utils.js';

function normalizeNodeSpec(raw: Record<string, unknown>, teamId: string): AgentTeamNodeSpec | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const agent = typeof raw.agent === 'string' ? raw.agent.trim() : '';
  const goalTemplate = typeof raw.goalTemplate === 'string' ? raw.goalTemplate : '';

  if (!id || !agent || !goalTemplate) {
    console.warn(`[AgentTeam] Invalid node in team ${teamId}, missing id/agent/goalTemplate`);
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

function normalizeTeamSpec(raw: unknown, sourcePath: string): AgentTeamSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : '';
  const version = typeof data.version === 'string' ? data.version.trim() : '1.0.0';

  if (!teamId) {
    console.warn(`[AgentTeam] teamId is required in ${sourcePath}`);
    return null;
  }

  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    console.warn(`[AgentTeam] nodes are required in ${sourcePath}`);
    return null;
  }

  const nodes: AgentTeamNodeSpec[] = [];
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
    console.warn(`[AgentTeam] no valid nodes in ${sourcePath}`);
    return null;
  }

  const finalAggregatorRaw = data.finalAggregator;
  const finalAggregator: AgentTeamFinalAggregatorSpec = {
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
    ? clampMaxParallel(Number(maxParallelRaw), DEFAULT_MAX_PARALLEL, MAX_PARALLEL_LIMIT)
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

function validateGraph(spec: AgentTeamSpec): void {
  const idSet = new Set<string>();
  for (const node of spec.nodes) {
    if (idSet.has(node.id)) {
      throw new Error(`[AgentTeam] Duplicate node id "${node.id}" in team "${spec.teamId}"`);
    }
    idSet.add(node.id);
  }

  for (const node of spec.nodes) {
    for (const dep of node.deps) {
      if (!idSet.has(dep)) {
        throw new Error(`[AgentTeam] Node "${node.id}" depends on missing node "${dep}" in team "${spec.teamId}"`);
      }
      if (dep === node.id) {
        throw new Error(`[AgentTeam] Node "${node.id}" cannot depend on itself`);
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

  const queue: string[] = Array.from(inDegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);

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
    throw new Error(`[AgentTeam] Team "${spec.teamId}" contains a cycle`);
  }
}

function teamScanPaths(cwd: string): string[] {
  return [
    path.join(homedir(), '.pulse-coder', 'teams'),
    path.join(homedir(), '.coder', 'teams'),
    path.join(cwd, '.coder', 'teams'),
    path.join(cwd, '.pulse-coder', 'teams')
  ];
}

export class AgentTeamRegistry implements AgentTeamRegistryService {
  private readonly specs = new Map<string, AgentTeamSpec>();

  constructor(private readonly cwd: string) {
    this.reload();
  }

  get(teamId: string): AgentTeamSpec | undefined {
    return this.specs.get(teamId);
  }

  list(): AgentTeamRegistrySummary[] {
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
          console.warn(`[AgentTeam] Failed to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return this.specs.size;
  }
}

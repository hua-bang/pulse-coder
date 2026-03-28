import type { TaskGraph, TaskNode, TeamRole } from './types';

export interface GraphBuildOptions {
  task: string;
  roles: TeamRole[];
}

export interface GraphValidationResult {
  valid: boolean;
  errors: string[];
}

export function buildTaskGraph(options: GraphBuildOptions): TaskGraph {
  const { task, roles } = options;
  const nodes: TaskNode[] = [];

  // researcher 先跑，无依赖
  if (roles.includes('researcher')) {
    nodes.push({
      id: 'research',
      role: 'researcher',
      deps: [],
      input: task,
      optional: true
    });
  }

  // executor 依赖 researcher（如有），否则无依赖
  const executeDeps = roles.includes('researcher') ? ['research'] : [];
  if (roles.includes('executor')) {
    nodes.push({
      id: 'execute',
      role: 'executor',
      deps: executeDeps,
      input: task
    });
  }

  // executor 完成后的基准节点（用于 reviewer/writer/tester 的共同依赖）
  const postExecuteDeps: string[] = roles.includes('executor') ? ['execute'] : executeDeps;

  // reviewer / writer / tester 都只依赖 postExecuteDeps，互相之间并行
  if (roles.includes('reviewer')) {
    nodes.push({
      id: 'review',
      role: 'reviewer',
      deps: [...postExecuteDeps],
      input: task,
      optional: true
    });
  }

  if (roles.includes('writer')) {
    nodes.push({
      id: 'write',
      role: 'writer',
      deps: [...postExecuteDeps],
      input: task,
      optional: true
    });
  }

  if (roles.includes('tester')) {
    nodes.push({
      id: 'test',
      role: 'tester',
      deps: [...postExecuteDeps],
      input: task,
      optional: true
    });
  }

  return { nodes };
}

export function validateTaskGraph(graph: TaskGraph): GraphValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
  }

  for (const node of graph.nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) {
        errors.push(`Missing dependency ${dep} for node ${node.id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

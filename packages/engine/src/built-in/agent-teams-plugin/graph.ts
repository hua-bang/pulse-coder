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

  if (roles.includes('researcher')) {
    nodes.push({
      id: 'research',
      role: 'researcher',
      deps: [],
      input: task,
      optional: true
    });
  }

  const executeDeps = nodes.map(node => node.id);
  if (roles.includes('executor')) {
    nodes.push({
      id: 'execute',
      role: 'executor',
      deps: executeDeps,
      input: task
    });
  }

  const reviewDeps = nodes.length > 0 ? [nodes[nodes.length - 1].id] : [];
  if (roles.includes('reviewer')) {
    nodes.push({
      id: 'review',
      role: 'reviewer',
      deps: reviewDeps,
      input: task,
      optional: true
    });
  }

  const writeDeps = nodes.length > 0 ? [nodes[nodes.length - 1].id] : [];
  if (roles.includes('writer')) {
    nodes.push({
      id: 'write',
      role: 'writer',
      deps: writeDeps,
      input: task,
      optional: true
    });
  }

  const testDeps = nodes.length > 0 ? [nodes[nodes.length - 1].id] : [];
  if (roles.includes('tester')) {
    nodes.push({
      id: 'test',
      role: 'tester',
      deps: testDeps,
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

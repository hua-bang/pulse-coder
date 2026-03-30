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
    nodes.push({ id: 'research', role: 'researcher', deps: [], input: `Research and analyze: ${task}`, optional: true });
  }

  const executeDeps = roles.includes('researcher') ? ['research'] : [];
  if (roles.includes('executor')) {
    nodes.push({ id: 'execute', role: 'executor', deps: executeDeps, input: `Implement changes: ${task}` });
  }

  const postExecuteDeps: string[] = roles.includes('executor') ? ['execute'] : executeDeps;

  if (roles.includes('reviewer')) {
    nodes.push({ id: 'review', role: 'reviewer', deps: [...postExecuteDeps], input: `Review the changes made for: ${task}`, optional: true });
  }
  if (roles.includes('writer')) {
    nodes.push({ id: 'write', role: 'writer', deps: [...postExecuteDeps], input: `Update documentation for: ${task}`, optional: true });
  }
  if (roles.includes('tester')) {
    nodes.push({ id: 'test', role: 'tester', deps: [...postExecuteDeps], input: `Write and run tests for: ${task}`, optional: true });
  }

  return { nodes };
}

export function validateTaskGraph(graph: TaskGraph): GraphValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of graph.nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) errors.push(`Missing dependency ${dep} for node ${node.id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

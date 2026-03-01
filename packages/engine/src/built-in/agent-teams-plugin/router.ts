import type { TeamRole } from './types';

const DEFAULT_KEYWORDS = {
  tester: [/\btest\b/i, /\btesting\b/i, /\btests\b/i, /\bqa\b/i, /测试/, /用例/],
  writer: [/\bdoc\b/i, /\bdocs\b/i, /\bdocument\b/i, /\bdocumentation\b/i, /文档/, /说明/],
  reviewer: [/\breview\b/i, /\bcode review\b/i, /评审/, /审查/]
};

export interface RouteDecision {
  roles: TeamRole[];
}

export function routeRoles(task: string, availableRoles: TeamRole[]): RouteDecision {
  const roles = new Set<TeamRole>();

  if (availableRoles.includes('researcher')) {
    roles.add('researcher');
  }

  if (availableRoles.includes('executor')) {
    roles.add('executor');
  }

  const normalizedTask = task.toLowerCase();

  if (availableRoles.includes('reviewer') && DEFAULT_KEYWORDS.reviewer.some(rule => rule.test(normalizedTask))) {
    roles.add('reviewer');
  }

  if (availableRoles.includes('writer') && DEFAULT_KEYWORDS.writer.some(rule => rule.test(normalizedTask))) {
    roles.add('writer');
  }

  if (availableRoles.includes('tester') && DEFAULT_KEYWORDS.tester.some(rule => rule.test(normalizedTask))) {
    roles.add('tester');
  }

  return { roles: Array.from(roles) };
}

import type { TeamRole } from './types';

export interface RoleRegistryConfig {
  roleTools?: Record<string, string>;
}

export class RoleRegistry {
  private roleTools: Record<string, string>;

  constructor(config?: RoleRegistryConfig) {
    this.roleTools = { ...defaultRoleTools(), ...(config?.roleTools ?? {}) };
  }

  getTool(role: TeamRole): string | undefined {
    return this.roleTools[role];
  }

  resolveRoleTools(overrides?: Record<string, string>): Record<string, string> {
    return { ...this.roleTools, ...(overrides ?? {}) };
  }

  getRoles(): TeamRole[] {
    return Object.keys(this.roleTools) as TeamRole[];
  }
}

export function defaultRoleTools(): Record<string, string> {
  return {
    researcher: 'researcher_agent',
    executor: 'executor_agent',
    reviewer: 'reviewer_agent',
    writer: 'writer_agent',
    tester: 'tester_agent'
  };
}

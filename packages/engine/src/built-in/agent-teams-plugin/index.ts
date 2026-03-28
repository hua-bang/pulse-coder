import { z } from 'zod';
import { randomUUID } from 'crypto';

import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { Tool } from '../../shared/types';

import { RoleRegistry } from './registry';
import { buildTaskGraph, validateTaskGraph } from './graph';
import { routeRoles } from './router';
import { runTaskGraph } from './scheduler';
import { aggregateResults } from './aggregator';
import { LocalArtifactStore } from './artifact-store';
import { planTaskGraph } from './planner';
import type { TeamRole, TeamRunInput, TeamRunOutput, TaskGraph } from './types';

const TEAM_RUN_INPUT_SCHEMA = z.object({
  task: z.string().describe('要执行的任务描述'),
  context: z.any().optional().describe('任务上下文信息'),
  roles: z.array(z.string()).optional().describe('明确指定的角色列表'),
  graph: z.any().optional().describe('自定义 TaskGraph'),
  route: z.enum(['auto', 'all', 'plan']).optional().describe('auto=关键词路由, all=全角色, plan=LLM动态规划'),
  includeRoles: z.array(z.string()).optional().describe('强制包含的角色'),
  excludeRoles: z.array(z.string()).optional().describe('排除的角色'),
  roleTools: z.record(z.string(), z.string()).optional().describe('角色到工具名称映射'),
  maxConcurrency: z.number().int().min(1).optional().describe('最大并发数'),
  nodeTimeoutMs: z.number().int().min(0).optional().describe('单节点超时'),
  retries: z.number().int().min(0).optional().describe('重试次数'),
  aggregate: z.enum(['concat']).optional().describe('聚合策略')
});

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRIES = 1;

export const builtInAgentTeamsPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-agent-teams',
  version: '1.0.0',
  dependencies: ['sub-agent'],

  async initialize(context: EnginePluginContext): Promise<void> {
    const registry = new RoleRegistry();

    const artifactStore = new LocalArtifactStore();

    const tool: Tool<TeamRunInput, TeamRunOutput> = {
      name: 'agent_teams_run',
      description: 'Run a fixed DAG agent team with role routing and aggregation.',
      defer_loading: true,
      inputSchema: TEAM_RUN_INPUT_SCHEMA,
      execute: async (input) => {
        const runId = randomUUID();
        const roleTools = registry.resolveRoleTools(input.roleTools);
        const tools = context.getTools();
        const availableRoles = Object.keys(roleTools) as TeamRole[];

        let roles: TeamRole[] = [];
        if (input.roles && input.roles.length > 0) {
          roles = input.roles as TeamRole[];
        } else if (input.route === 'all') {
          roles = availableRoles;
        } else {
          roles = routeRoles(input.task, availableRoles).roles;
        }

        if (input.includeRoles?.length) {
          roles = Array.from(new Set([...roles, ...(input.includeRoles as TeamRole[])]));
        }
        if (input.excludeRoles?.length) {
          const excluded = new Set(input.excludeRoles as TeamRole[]);
          roles = roles.filter(role => !excluded.has(role));
        }

        let graph: TaskGraph;
        if (input.graph) {
          graph = input.graph as TaskGraph;
        } else if (input.route === 'plan') {
          context.logger.info('[AgentTeams] Planning task graph with LLM...');
          graph = await planTaskGraph({ task: input.task, availableRoles });
        } else {
          graph = buildTaskGraph({ task: input.task, roles });
        }

        const validation = validateTaskGraph(graph);
        if (!validation.valid) {
          throw new Error(`Invalid TaskGraph: ${validation.errors.join('; ')}`);
        }

        const results = await runTaskGraph({
          context,
          graph,
          task: input.task,
          runId,
          maxConcurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
          retries: input.retries ?? DEFAULT_RETRIES,
          nodeTimeoutMs: input.nodeTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          roleTools,
          tools,
          runContext: input.context,
          artifactStore
        });

        return {
          task: input.task,
          roles,
          graph,
          results,
          aggregate: aggregateResults({ results })
        };
      }
    };

    context.registerTool('agent_teams_run', tool);
    context.registerService('agentTeamsRoleRegistry', registry);
    context.logger.info('[AgentTeams] Built-in agent teams plugin initialized');
  }
};

export default builtInAgentTeamsPlugin;

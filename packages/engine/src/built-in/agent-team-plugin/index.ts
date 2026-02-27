import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { Tool } from '../../shared/types.js';

import { AGENT_TEAM_REGISTRY_SERVICE_KEY, TEAM_RUN_TOOL_NAME } from './constants.js';
import { AgentTeamRegistry } from './registry.js';
import { teamRunSchema } from './schema.js';
import type { TeamRunInput } from './schema.js';
import type { AgentTeamRegistryService, AgentTeamRunResult } from './types.js';
import { runAgentTeam } from './runner.js';

export const builtInAgentTeamPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-agent-team',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const registry = new AgentTeamRegistry(process.cwd());

    context.registerService<AgentTeamRegistryService>(AGENT_TEAM_REGISTRY_SERVICE_KEY, registry);

    const teamRunTool: Tool<TeamRunInput, AgentTeamRunResult> = {
      name: TEAM_RUN_TOOL_NAME,
      description: [
        'Run a fixed-role agent team with DAG scheduling.',
        'Team specs are loaded from .pulse-coder/teams/*.team.json (also supports .coder/teams).',
        'Each node maps to an agent tool (e.g. code-reviewer_agent).'
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
        return runAgentTeam(spec, input, allTools, toolExecutionContext);
      }
    };

    context.registerTool(teamRunTool.name, teamRunTool);
    context.logger.info(`[AgentTeam] Loaded ${registry.list().length} team specs`);
  }
};

export type {
  AgentTeamNodeResult,
  AgentTeamNodeSpec,
  AgentTeamRegistryService,
  AgentTeamRegistrySummary,
  AgentTeamRunResult,
  AgentTeamSpec
} from './types.js';
export { AgentTeamRegistry } from './registry.js';

export default builtInAgentTeamPlugin;

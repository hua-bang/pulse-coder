import { randomUUID } from 'node:crypto';
import type { OrchestrationInput, OrchestrationResult, TaskGraph, TeamRole } from './types';
import type { AgentRunner, OrchestratorLogger } from './runner';
import type { ArtifactStore } from './artifact-store';
import { LocalArtifactStore } from './artifact-store';
import { buildTaskGraph, validateTaskGraph } from './graph';
import { routeRoles } from './router';
import { planTaskGraph } from './planner';
import { runTaskGraph } from './scheduler';
import { aggregateResultsAsync } from './aggregator';
import { defaultLogger } from './runner';

const DEFAULT_ROLE_AGENTS: Record<string, string> = {
  researcher: 'researcher_agent',
  executor:   'executor_agent',
  reviewer:   'reviewer_agent',
  writer:     'writer_agent',
  tester:     'tester_agent',
};

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRIES = 1;

export interface OrchestratorOptions {
  runner: AgentRunner;
  artifactStore?: ArtifactStore;
  logger?: OrchestratorLogger;
  /** 角色到 agent 名称的默认映射，可覆盖内置默认值 */
  defaultRoleAgents?: Record<string, string>;
  /** 调用 LLM 的函数，plan 模式下必须提供 */
  llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export class Orchestrator {
  private runner: AgentRunner;
  private artifactStore: ArtifactStore;
  private logger: OrchestratorLogger;
  private defaultRoleAgents: Record<string, string>;
  private llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>;

  constructor(options: OrchestratorOptions) {
    this.runner = options.runner;
    this.artifactStore = options.artifactStore ?? new LocalArtifactStore();
    this.logger = options.logger ?? defaultLogger;
    this.defaultRoleAgents = { ...DEFAULT_ROLE_AGENTS, ...(options.defaultRoleAgents ?? {}) };
    this.llmCall = options.llmCall;
  }

  async run(input: OrchestrationInput): Promise<OrchestrationResult> {
    const runId = randomUUID();
    const roleAgents = { ...this.defaultRoleAgents, ...(input.roleAgents ?? {}) };
    const availableRoles = Object.keys(roleAgents) as TeamRole[];

    this.logger.info(`Starting orchestration run ${runId}: ${input.task.slice(0, 80)}`);

    const route = input.route ?? 'plan';

    // Determine role list
    let roles: TeamRole[];
    if (input.roles?.length) {
      roles = input.roles;
    } else if (route === 'all') {
      roles = availableRoles;
    } else if (route === 'auto') {
      roles = routeRoles(input.task, availableRoles);
    } else {
      // 'plan' mode: all roles are available for the planner to choose from
      roles = availableRoles;
    }

    if (input.includeRoles?.length) {
      roles = Array.from(new Set([...roles, ...input.includeRoles]));
    }
    if (input.excludeRoles?.length) {
      const excluded = new Set(input.excludeRoles);
      roles = roles.filter(r => !excluded.has(r));
    }

    // Build TaskGraph
    let graph: TaskGraph;
    if (input.graph) {
      graph = input.graph;
    } else if (route === 'plan') {
      if (!this.llmCall) throw new Error('llmCall is required for route="plan"');
      this.logger.info('Planning task graph with LLM...');
      graph = await planTaskGraph({ task: input.task, availableRoles: roles, llmCall: this.llmCall });
    } else {
      graph = buildTaskGraph({ task: input.task, roles });
    }

    const validation = validateTaskGraph(graph);
    if (!validation.valid) {
      throw new Error(`Invalid TaskGraph: ${validation.errors.join('; ')}`);
    }

    this.logger.onGraphReady?.(graph, roles);
    this.logger.info(`Executing graph with ${graph.nodes.length} nodes`);

    const results = await runTaskGraph({
      runner: this.runner,
      graph,
      task: input.task,
      runId,
      roleAgents,
      maxConcurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      retries: input.retries ?? DEFAULT_RETRIES,
      nodeTimeoutMs: input.nodeTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      artifactStore: this.artifactStore,
      runContext: input.context,
      logger: this.logger,
    });

    const aggregateStrategy = input.aggregate ?? 'llm';
    const aggregate = await aggregateResultsAsync(results, aggregateStrategy, this.llmCall);
    this.logger.info(`Orchestration run ${runId} completed`);

    return { task: input.task, runId, roles, graph, results, aggregate };
  }
}

import { randomUUID } from 'crypto';

import type { Tool, ToolExecutionContext } from '../../shared/types.js';

import { DEFAULT_MAX_PARALLEL, MAX_PARALLEL_LIMIT } from './constants.js';
import { aggregateFinalText } from './aggregator.js';
import type {
  AgentTeamNodeResult,
  AgentTeamNodeSpec,
  AgentTeamRunResult,
  AgentTeamSpec
} from './types.js';
import type { TeamRunInput } from './schema.js';
import { renderTemplate } from './template.js';
import { chunk, clampMaxParallel, resolveAgentTool, withTimeout } from './utils.js';

function buildDependencyContext(node: AgentTeamNodeSpec, states: Map<string, AgentTeamNodeResult>) {
  return Object.fromEntries(
    node.deps.map((depId) => [depId, {
      status: states.get(depId)?.status,
      output: states.get(depId)?.output,
      error: states.get(depId)?.error
    }])
  );
}

async function executeNode(
  node: AgentTeamNodeSpec,
  states: Map<string, AgentTeamNodeResult>,
  tools: Record<string, Tool>,
  runInput: TeamRunInput,
  toolExecutionContext?: ToolExecutionContext
): Promise<AgentTeamNodeResult> {
  const state = states.get(node.id);
  if (!state) {
    throw new Error(`Missing node state for ${node.id}`);
  }

  const depsContext = buildDependencyContext(node, states);
  const task = renderTemplate(node.goalTemplate, {
    goal: runInput.goal,
    input: runInput.input ?? {},
    deps: depsContext,
    node: {
      id: node.id,
      agent: node.agent
    }
  });

  const agentTool = resolveAgentTool(tools, node.agent);

  let attempts = 0;
  let lastError: Error | null = null;

  while (attempts <= node.retries) {
    attempts += 1;
    try {
      const runPromise = Promise.resolve(agentTool.execute({
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

  state.status = node.optional ? 'skipped' : 'failed';
  state.error = lastError?.message ?? 'Unknown node failure';
  return state;
}

function markBlockedNodes(spec: AgentTeamSpec, states: Map<string, AgentTeamNodeResult>): void {
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
  }
}

function pickReadyNodes(spec: AgentTeamSpec, states: Map<string, AgentTeamNodeResult>): AgentTeamNodeSpec[] {
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

function createInitialStates(spec: AgentTeamSpec): Map<string, AgentTeamNodeResult> {
  const states = new Map<string, AgentTeamNodeResult>();
  for (const node of spec.nodes) {
    states.set(node.id, {
      id: node.id,
      agent: node.agent,
      status: 'pending',
      attempts: 0
    });
  }
  return states;
}

function buildTrace(spec: AgentTeamSpec, states: Map<string, AgentTeamNodeResult>): AgentTeamNodeResult[] {
  return spec.nodes.map((node) => {
    const state = states.get(node.id);
    if (!state) {
      return {
        id: node.id,
        agent: node.agent,
        status: 'skipped',
        error: 'state_not_found',
        attempts: 0
      };
    }
    return state;
  });
}

export async function runAgentTeam(
  spec: AgentTeamSpec,
  input: TeamRunInput,
  tools: Record<string, Tool>,
  toolExecutionContext?: ToolExecutionContext
): Promise<AgentTeamRunResult> {
  const runId = randomUUID();
  const maxParallel = clampMaxParallel(input.maxParallel, spec.maxParallel, MAX_PARALLEL_LIMIT);
  const states = createInitialStates(spec);

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

    for (const wave of chunk(readyNodes, maxParallel)) {
      await Promise.all(
        wave.map(async (node) => {
          const state = states.get(node.id);
          if (!state) {
            return;
          }

          state.status = 'running';
          state.startedAt = Date.now();
          const result = await executeNode(node, states, tools, input, toolExecutionContext);
          result.endedAt = Date.now();
          states.set(node.id, result);
        })
      );

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

  const trace = buildTrace(spec, states);
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

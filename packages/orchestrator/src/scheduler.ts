import type { NodeResult, TaskGraph, TaskNode } from './types';
import type { AgentRunner, OrchestratorLogger } from './runner';
import type { ArtifactStore } from './artifact-store';

export interface ScheduleOptions {
  runner: AgentRunner;
  graph: TaskGraph;
  task: string;
  runId: string;
  roleAgents: Record<string, string>;
  maxConcurrency: number;
  retries: number;
  nodeTimeoutMs: number;
  artifactStore?: ArtifactStore;
  runContext?: Record<string, any>;
  logger: OrchestratorLogger;
}

export async function runTaskGraph(options: ScheduleOptions): Promise<Record<string, NodeResult>> {
  const { graph, maxConcurrency, retries, nodeTimeoutMs, logger } = options;
  const nodes = graph.nodes;
  const results: Record<string, NodeResult> = {};

  if (nodes.length === 0) return results;

  const pending = new Set(nodes.map(n => n.id));
  const inFlight = new Map<string, Promise<void>>();
  const resolved = new Set<string>();  // completed or skipped-optional — downstream can proceed
  const hardFailed = new Set<string>(); // non-optional failures — blocks dependents
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const canRun = (node: TaskNode) =>
    node.deps.every(dep => resolved.has(dep));

  const markSkipped = (node: TaskNode, reason: string) => {
    const now = Date.now();
    results[node.id] = { nodeId: node.id, role: node.role, status: 'skipped', attempts: 0, startedAt: now, endedAt: now, durationMs: 0, skippedReason: reason };
    pending.delete(node.id);
    resolved.add(node.id);
  };

  const runNode = async (node: TaskNode) => {
    const { runner, task, roleAgents, artifactStore, runId, runContext } = options;
    const now = Date.now();
    const result: NodeResult = { nodeId: node.id, role: node.role, status: 'failed', attempts: 0, startedAt: now, endedAt: now, durationMs: 0 };

    const agentName = node.agent ?? roleAgents[node.role];
    if (!agentName) {
      const reason = `Missing agent for role ${node.role}`;
      result.status = node.optional ? 'skipped' : 'failed';
      result.error = reason;
      result.skippedReason = node.optional ? reason : undefined;
      result.endedAt = Date.now();
      result.durationMs = result.endedAt - result.startedAt;
      results[node.id] = result;
      if (result.status === 'failed') failed.add(node.id);
      return;
    }

    logger.info(`Starting: ${node.id} (${node.role}) → ${agentName}`);

    // Collect upstream results — inline the output so the agent doesn't need to read files
    const depOutputs = node.deps
      .map(dep => {
        const r = results[dep];
        return r?.status === 'success' && r.output
          ? { role: r.role, nodeId: dep, output: r.output }
          : null;
      })
      .filter((d): d is { role: string; nodeId: string; output: string } => d !== null);

    const depNote = depOutputs.length > 0
      ? '\n\n--- Upstream results ---\n' + depOutputs.map(d =>
          `### [${d.role}] ${d.nodeId}\n${d.output}`
        ).join('\n\n') + '\n--- End of upstream results ---\n\nUse the upstream results above to inform your work.'
      : '';

    const taskInput = node.instruction
      ? `${node.instruction}\n\n${node.input ?? task}${depNote}`
      : `${node.input ?? task}${depNote}`;

    const runOnce = async () => {
      result.attempts += 1;
      result.agentName = agentName;
      const output = await runner.run({ agentName, task: taskInput, context: { task, role: node.role, nodeId: node.id, deps: node.deps, runContext } });
      result.output = output;
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) logger.warn(`Retrying ${node.id} (attempt ${attempt + 1}/${retries + 1})`);
      try {
        await withTimeout(runOnce(), nodeTimeoutMs);
        result.status = 'success';
        result.endedAt = Date.now();
        result.durationMs = result.endedAt - result.startedAt;
        results[node.id] = result;

        if (artifactStore && result.output) {
          try { await artifactStore.write(runId, node.id, node.role, result.output); } catch { /* non-fatal */ }
        }

        resolved.add(node.id);
        logger.info(`Node ${node.id} (${node.role}) completed in ${result.durationMs}ms`);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    const msg = lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown error');
    result.error = msg;
    result.endedAt = Date.now();
    result.durationMs = result.endedAt - result.startedAt;

    if (node.optional) {
      result.status = 'skipped';
      result.skippedReason = msg;
      resolved.add(node.id);  // optional failure does not block downstream
      logger.warn(`Node ${node.id} (${node.role}) failed (optional, skipped): ${msg}`);
    } else {
      result.status = 'failed';
      hardFailed.add(node.id);
      logger.error(`Node ${node.id} (${node.role}) failed: ${msg}`);
    }
    results[node.id] = result;
  };

  while (pending.size > 0) {
    const runnable = Array.from(pending)
      .map(id => nodeById.get(id))
      .filter((n): n is TaskNode => !!n && canRun(n));

    if (runnable.length === 0) {
      if (inFlight.size > 0) {
        // Wait for in-flight nodes to finish — they may unblock pending nodes
        await Promise.race(inFlight.values());
        continue;
      }
      if (hardFailed.size > 0) {
        for (const id of pending) {
          const node = nodeById.get(id);
          if (node) markSkipped(node, 'Blocked by failed dependency');
        }
        break;
      }
      throw new Error('No runnable nodes; check DAG for cycles');
    }

    while (runnable.length > 0 && inFlight.size < maxConcurrency) {
      const node = runnable.shift()!;
      pending.delete(node.id);
      const p = runNode(node).finally(() => inFlight.delete(node.id));
      inFlight.set(node.id, p);
    }

    if (inFlight.size > 0) await Promise.race(inFlight.values());
  }

  if (inFlight.size > 0) await Promise.all(inFlight.values());
  return results;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return promise;
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error('Node execution timed out')), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (id) clearTimeout(id); }
}

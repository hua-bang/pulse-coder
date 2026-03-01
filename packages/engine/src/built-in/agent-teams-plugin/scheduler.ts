import type { NodeResult, TaskGraph, TaskNode } from './types';
import type { EnginePluginContext } from '../../plugin/EnginePlugin';

export interface ScheduleOptions {
  context: EnginePluginContext;
  graph: TaskGraph;
  task: string;
  maxConcurrency: number;
  retries: number;
  nodeTimeoutMs: number;
  roleTools: Record<string, string>;
  tools: Record<string, any>;
  runContext?: Record<string, any>;
}

export async function runTaskGraph(options: ScheduleOptions): Promise<Record<string, NodeResult>> {
  const { graph, maxConcurrency, retries, nodeTimeoutMs } = options;
  const nodes = graph.nodes;
  const results: Record<string, NodeResult> = {};

  if (nodes.length === 0) {
    return results;
  }

  const pending = new Set<string>(nodes.map(node => node.id));
  const inFlight = new Map<string, Promise<void>>();
  const completed = new Set<string>();
  const failed = new Set<string>();

  const nodeById = new Map(nodes.map(node => [node.id, node] as const));

  const canRunNode = (node: TaskNode): boolean => {
    if (failed.size > 0) {
      return false;
    }
    return node.deps.every(dep => completed.has(dep));
  };

  const markSkipped = (node: TaskNode, reason: string) => {
    const now = Date.now();
    results[node.id] = {
      nodeId: node.id,
      role: node.role,
      status: 'skipped',
      attempts: 0,
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      skippedReason: reason
    };
    pending.delete(node.id);
  };

  const runNode = async (node: TaskNode) => {
    const { context, task, roleTools, tools, runContext } = options;
    const now = Date.now();
    const result: NodeResult = {
      nodeId: node.id,
      role: node.role,
      status: 'failed',
      attempts: 0,
      startedAt: now,
      endedAt: now,
      durationMs: 0
    };

    const toolName = node.tool ?? roleTools[node.role];
    if (!toolName) {
      const reason = `Missing tool for role ${node.role}`;
      result.status = node.optional ? 'skipped' : 'failed';
      result.error = reason;
      result.skippedReason = node.optional ? reason : undefined;
      result.endedAt = Date.now();
      result.durationMs = result.endedAt - result.startedAt;
      results[node.id] = result;
      if (result.status === 'failed') {
        failed.add(node.id);
      }
      return;
    }

    if (!tools[toolName]) {
      const reason = `Tool not found: ${toolName}`;
      result.status = node.optional ? 'skipped' : 'failed';
      result.error = reason;
      result.skippedReason = node.optional ? reason : undefined;
      result.toolName = toolName;
      result.endedAt = Date.now();
      result.durationMs = result.endedAt - result.startedAt;
      results[node.id] = result;
      if (result.status === 'failed') {
        failed.add(node.id);
      }
      return;
    }

    const runOnce = async () => {
      const input = {
        task: node.input ?? task,
        context: {
          task,
          role: node.role,
          nodeId: node.id,
          deps: node.deps,
          runContext
        }
      };
      const tool = tools[toolName];
      result.attempts += 1;
      result.toolName = toolName;
      const output = await tool.execute(input);
      result.output = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await withTimeout(runOnce(), nodeTimeoutMs);
        result.status = 'success';
        result.endedAt = Date.now();
        result.durationMs = result.endedAt - result.startedAt;
        results[node.id] = result;
        completed.add(node.id);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown error');
    result.status = node.optional ? 'skipped' : 'failed';
    result.error = errorMessage;
    result.skippedReason = node.optional ? errorMessage : undefined;
    result.endedAt = Date.now();
    result.durationMs = result.endedAt - result.startedAt;
    results[node.id] = result;
    if (result.status === 'failed') {
      failed.add(node.id);
    }
  };

  while (pending.size > 0) {
    const runnable = Array.from(pending)
      .map(id => nodeById.get(id))
      .filter((node): node is TaskNode => !!node && canRunNode(node));

    if (runnable.length === 0) {
      if (failed.size > 0) {
        for (const id of pending) {
          const node = nodeById.get(id);
          if (node) {
            markSkipped(node, 'Blocked by failed dependency');
          }
        }
        break;
      }
      throw new Error('No runnable nodes available; check DAG for cycles');
    }

    while (runnable.length > 0 && inFlight.size < maxConcurrency) {
      const node = runnable.shift();
      if (!node) {
        continue;
      }
      pending.delete(node.id);
      const promise = runNode(node).finally(() => {
        inFlight.delete(node.id);
      });
      inFlight.set(node.id, promise);
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight.values());
    }
  }

  if (inFlight.size > 0) {
    await Promise.all(inFlight.values());
  }

  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Node execution timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

import type { TaskGraph, TeamRole } from './types';

export interface PlannerOptions {
  task: string;
  availableRoles: TeamRole[];
  /** LLM call function, injected externally to decouple from engine ai module */
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

const SYSTEM_PROMPT = `You are a task graph planner for a multi-agent system.
Given a user task, output a TaskGraph JSON that assigns the right agents and execution order.

TaskGraph format:
{
  "nodes": [
    {
      "id": "unique_identifier",
      "role": "role_name",
      "deps": ["dependency_node_ids"],
      "input": "specific sub-task description for this node (REQUIRED)",
      "optional": true/false
    }
  ]
}

Available roles and when to use them:
- researcher: read-only analysis, code investigation, information gathering. Use for any task that needs understanding before action.
- executor: code changes, implementation, refactoring. Only include when the task requires modifying code.
- reviewer: read-only code review, quality checks. Use after executor, or standalone for review-only tasks.
- writer: documentation updates. Only include when docs need updating.
- tester: write and run tests. Only include when tests are needed.

Rules:
- deps must reference existing node ids, no cycles allowed.
- Nodes without dependency relationships run in parallel.
- Set optional=true for nodes whose failure should not block downstream.
- Only use roles from the availableRoles list.
- The "input" field MUST contain a specific, actionable sub-task description tailored to that node's role. Do NOT just copy the original task verbatim.
- For read-only tasks (review, analyze, summarize), do NOT include executor.
- Output raw JSON only, no markdown fences, no explanation.`;

export async function planTaskGraph(options: PlannerOptions): Promise<TaskGraph> {
  const { task, availableRoles, llmCall } = options;

  const userPrompt = `Task: ${task}\n\nAvailable roles: ${availableRoles.join(', ')}\n\nOutput TaskGraph JSON:`;
  const raw = (await llmCall(SYSTEM_PROMPT, userPrompt)).trim();

  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? null;
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;

  let graph: TaskGraph;
  try {
    graph = JSON.parse(jsonStr) as TaskGraph;
  } catch {
    throw new Error(`Planner returned invalid JSON: ${jsonStr.slice(0, 200)}`);
  }

  if (!Array.isArray(graph.nodes)) {
    throw new Error('Planner returned invalid TaskGraph: missing nodes array');
  }

  return graph;
}

import type { ILogger } from 'pulse-coder-engine';
import { generateTextAI } from 'pulse-coder-engine';
import type { CreateTaskInput, TeammateOptions, EngineOptions } from './types.js';

/**
 * LLM-based task planner.
 * Given a high-level task description and available teammate roles,
 * uses an LLM to decompose it into concrete sub-tasks with dependencies.
 */

export interface PlannerOptions {
  /** Custom LLM call. Falls back to engine's generateTextAI. */
  llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  logger?: ILogger;
}

export interface TeamPlan {
  /** Suggested teammates to spawn. */
  teammates: Array<{
    name: string;
    role: string;
    spawnPrompt: string;
    model?: string;
  }>;
  /** Tasks to create, with optional inter-task dependencies. */
  tasks: Array<CreateTaskInput & {
    /** Teammate name to assign to. */
    assignTo?: string;
    /** Names (not IDs) of dependency tasks. Resolved to IDs post-creation. */
    depNames?: string[];
  }>;
}

const PLANNER_SYSTEM_PROMPT = `You are a team planning assistant. Given a high-level task, you decompose it into:
1. A list of teammates (each with a name, role description, and spawn prompt)
2. A list of concrete sub-tasks (each with title, description, optional assignee name, and dependency names)

Rules:
- Each teammate should have a distinct, focused role.
- Tasks should be concrete and actionable, not vague.
- Use dependencies to enforce ordering ONLY when strictly necessary (e.g. task B literally cannot start without task A's output).
- MAXIMIZE PARALLELISM: most tasks should have NO dependencies (empty depNames). Each teammate should be able to start working immediately on their own tasks. Avoid a single "setup" or "research" task that blocks everything.
- Do NOT create a shared first task that all other tasks depend on. Instead, let each teammate do their own scoping/research as part of their task.
- Assign tasks to teammates whose role fits the task.
- Aim for 3-6 teammates and 5-15 tasks unless the scope requires more.
- Each teammate should have at least one task with no dependencies so they can start immediately.

Respond ONLY with a JSON object matching this schema:
{
  "teammates": [
    { "name": "researcher", "role": "Research and investigate", "spawnPrompt": "You are a researcher. ..." }
  ],
  "tasks": [
    { "title": "...", "description": "...", "assignTo": "researcher", "depNames": [] },
    { "title": "...", "description": "...", "assignTo": "implementer", "depNames": ["Research the codebase"] }
  ]
}

Do not include markdown fences. Return raw JSON only.`;

/**
 * Use LLM to plan the team structure and tasks for a given goal.
 */
export async function planTeam(
  taskDescription: string,
  options?: PlannerOptions,
): Promise<TeamPlan> {
  const logger = options?.logger || console;

  const userPrompt = `Plan a team to accomplish this task:\n\n${taskDescription}`;

  let response: string;

  if (options?.llmCall) {
    response = await options.llmCall(PLANNER_SYSTEM_PROMPT, userPrompt);
  } else {
    // Use engine's generateTextAI with system prompt
    const result = await generateTextAI(
      [{ role: 'user', content: userPrompt }],
      {}, // no tools needed for planning
      { systemPrompt: PLANNER_SYSTEM_PROMPT },
    );
    response = result.text;
  }

  try {
    // Strip markdown fences if present
    const cleaned = response.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const plan = JSON.parse(cleaned) as TeamPlan;
    validatePlan(plan);
    return plan;
  } catch (err: any) {
    logger.error('Failed to parse LLM plan response', err);
    logger.debug(`Raw response: ${response}`);
    throw new Error(`Plan parsing failed: ${err.message}`);
  }
}

function validatePlan(plan: TeamPlan): void {
  if (!Array.isArray(plan.teammates) || plan.teammates.length === 0) {
    throw new Error('Plan must have at least one teammate');
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Plan must have at least one task');
  }
  for (const t of plan.teammates) {
    if (!t.name || !t.role) {
      throw new Error(`Teammate missing name or role: ${JSON.stringify(t)}`);
    }
  }
  for (const t of plan.tasks) {
    if (!t.title || !t.description) {
      throw new Error(`Task missing title or description: ${JSON.stringify(t)}`);
    }
  }
}

/**
 * Convert a TeamPlan into concrete TeammateOptions + CreateTaskInput arrays.
 * Resolves depNames → actual task IDs after creation.
 */
export function buildTeammateOptionsFromPlan(
  plan: TeamPlan,
  baseEngineOptions?: EngineOptions,
  logger?: ILogger,
): TeammateOptions[] {
  return plan.teammates.map((t, i) => ({
    id: `${t.name}-${i}`,
    name: t.name,
    spawnPrompt: t.spawnPrompt,
    model: t.model,
    engineOptions: baseEngineOptions,
    logger,
  }));
}

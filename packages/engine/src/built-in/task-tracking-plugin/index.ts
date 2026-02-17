import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import type { BuiltInSkillRegistry, SkillInfo } from '../skills-plugin';

import type { Tool } from '../../shared/types';
import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';

const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface WorkTask {
  id: string;
  title: string;
  details?: string;
  status: TaskStatus;
  dependencies: string[];
  blockedReason?: string;
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WorkTaskListSnapshot {
  taskListId: string;
  storagePath: string;
  createdAt: number;
  updatedAt: number;
  total: number;
  tasks: WorkTask[];
}

interface TaskListStoreFile {
  taskListId: string;
  createdAt: number;
  updatedAt: number;
  tasks: WorkTask[];
}

interface CreateTaskInput {
  title: string;
  details?: string;
  status?: TaskStatus;
  dependencies?: string[];
  blockedReason?: string;
  metadata?: Record<string, any>;
}

interface ListTaskOptions {
  statuses?: TaskStatus[];
  includeCompleted?: boolean;
  limit?: number;
}

interface UpdateTaskInput {
  id: string;
  title?: string;
  details?: string;
  status?: TaskStatus;
  dependencies?: string[];
  blockedReason?: string;
  metadata?: Record<string, any>;
  delete?: boolean;
}

const CREATE_TASK_ITEM_SCHEMA = z.object({
  title: z.string().min(1).describe('Task title'),
  details: z.string().optional().describe('Task details / acceptance notes'),
  status: z.enum(TASK_STATUSES).optional().describe('Initial status; defaults to pending'),
  dependencies: z.array(z.string()).optional().describe('Task IDs that must be completed first'),
  blockedReason: z.string().optional().describe('Reason when status is blocked'),
  metadata: z.record(z.string(), z.any()).optional().describe('Additional machine-readable metadata')
});

const TASK_CREATE_INPUT_SCHEMA = z
  .object({
    title: z.string().min(1).optional().describe('Task title (single-task mode)'),
    details: z.string().optional().describe('Task details (single-task mode)'),
    status: z.enum(TASK_STATUSES).optional().describe('Initial status (single-task mode)'),
    dependencies: z.array(z.string()).optional().describe('Dependencies (single-task mode)'),
    blockedReason: z.string().optional().describe('Blocked reason (single-task mode)'),
    metadata: z.record(z.string(), z.any()).optional().describe('Metadata (single-task mode)'),
    tasks: z.array(CREATE_TASK_ITEM_SCHEMA).min(1).optional().describe('Batch create mode')
  })
  .refine((value) => !!value.tasks?.length || !!value.title, {
    message: 'Either provide `tasks` or `title` for single-task mode.'
  });

const TASK_GET_INPUT_SCHEMA = z.object({
  id: z.string().min(1).describe('Task ID to retrieve')
});

const TASK_LIST_INPUT_SCHEMA = z.object({
  statuses: z.array(z.enum(TASK_STATUSES)).optional().describe('Filter by statuses'),
  includeCompleted: z.boolean().optional().describe('Set false to hide completed tasks'),
  limit: z.number().int().positive().max(500).optional().describe('Maximum tasks to return')
});
const TASK_TRACKING_SKILL: SkillInfo = {
  name: 'task-tracking-workflow',
  description: 'Track complex execution with task tools and proceed directly without confirmation unless the user explicitly asks for confirmation.',
  location: 'pulse-coder-engine/built-in/task-tracking-plugin',
  content: `# Task Tracking Workflow

## When to use
- The request has multiple phases or deliverables.
- Work may span multiple tool calls or sessions.
- You need explicit progress visibility and blocker management.

## Execution autonomy
- Default behavior: execute directly and call tools without asking for confirmation.
- Only ask for confirmation when the user explicitly requires confirmation.
- If critical information is missing, ask only the minimum clarifying question needed to continue.

## Required flow
1. Start by reviewing existing tasks with \`task_list\`.
2. If no suitable tasks exist, create focused tasks with \`task_create\` (prefer batch mode).
3. Keep exactly one primary task in \`in_progress\` where possible.
4. Update status with \`task_update\` after meaningful progress.
5. Mark blockers with \`status=blocked\` and a concrete \`blockedReason\`.
6. Mark done tasks as \`completed\` and move to the next actionable item.

## Quality rules
- Keep tasks atomic and verifiable.
- Avoid single oversized umbrella tasks.
- Reuse existing in-progress tasks instead of duplicating.
- Keep dependency links explicit when order matters.`
};

const TASK_UPDATE_INPUT_SCHEMA = z.object({
  id: z.string().min(1).describe('Task ID to update'),
  title: z.string().min(1).optional().describe('New title'),
  details: z.string().optional().describe('New details'),
  status: z.enum(TASK_STATUSES).optional().describe('New status'),
  dependencies: z.array(z.string()).optional().describe('Replace dependencies with this list'),
  blockedReason: z.string().optional().describe('Blocked reason, used with status=blocked'),
  metadata: z.record(z.string(), z.any()).optional().describe('Replace metadata object'),
  delete: z.boolean().optional().describe('Delete this task')
});

function normalizeTaskListId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'default';
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'default';
}

function now(): number {
  return Date.now();
}


function dedupeStrings(values: string[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

export class TaskListService {
  taskListId: string;
  storagePath: string;

  private readonly storageDir: string;
  private initialized = false;
  private createdAt = now();
  private updatedAt = now();
  private tasks = new Map<string, WorkTask>();

  constructor(
    taskListId: string = TaskListService.resolveTaskListId(),
    storageDir: string = TaskListService.resolveStorageDir()
  ) {
    const normalized = normalizeTaskListId(taskListId);

    this.storageDir = storageDir;
    this.taskListId = normalized;
    this.storagePath = path.join(this.storageDir, `${normalized}.json`);
  }

  static resolveTaskListId(): string {
    return process.env.PULSE_CODER_TASK_LIST_ID
      || process.env.CLAUDE_CODE_TASK_LIST_ID
      || 'default';
  }

  static resolveStorageDir(): string {
    return process.env.PULSE_CODER_TASKS_DIR
      || path.join(homedir(), '.pulse-coder', 'tasks');
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.loadTaskList(this.taskListId);
  }

  async setTaskListId(taskListId: string): Promise<{ switched: boolean; taskListId: string; storagePath: string }> {
    await this.initialize();

    const normalized = normalizeTaskListId(taskListId);
    if (normalized === this.taskListId) {
      return {
        switched: false,
        taskListId: this.taskListId,
        storagePath: this.storagePath
      };
    }

    await this.loadTaskList(normalized);

    return {
      switched: true,
      taskListId: this.taskListId,
      storagePath: this.storagePath
    };
  }

  async createTask(input: CreateTaskInput): Promise<WorkTask> {
    await this.initialize();

    const timestamp = now();
    const status = input.status ?? 'pending';

    const task: WorkTask = {
      id: randomUUID(),
      title: input.title.trim(),
      details: input.details,
      status,
      dependencies: dedupeStrings(input.dependencies),
      blockedReason: status === 'blocked' ? input.blockedReason ?? 'Blocked without reason' : undefined,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: status === 'completed' ? timestamp : undefined
    };

    this.tasks.set(task.id, task);
    this.updatedAt = timestamp;
    await this.persist();

    return task;
  }

  async createTasks(inputs: CreateTaskInput[]): Promise<WorkTask[]> {
    const created: WorkTask[] = [];
    for (const input of inputs) {
      created.push(await this.createTask(input));
    }
    return created;
  }

  async listTasks(options?: ListTaskOptions): Promise<WorkTask[]> {
    await this.initialize();

    const statuses = options?.statuses?.length ? new Set(options.statuses) : null;
    const includeCompleted = options?.includeCompleted ?? true;

    let tasks = Array.from(this.tasks.values()).filter((task) => {
      if (!includeCompleted && task.status === 'completed') {
        return false;
      }
      if (statuses && !statuses.has(task.status)) {
        return false;
      }
      return true;
    });

    tasks = tasks.sort((a, b) => a.createdAt - b.createdAt);

    if (options?.limit && options.limit > 0) {
      tasks = tasks.slice(0, options.limit);
    }

    return tasks;
  }

  async getTask(id: string): Promise<WorkTask | null> {
    await this.initialize();
    return this.tasks.get(id) ?? null;
  }

  async updateTask(input: UpdateTaskInput): Promise<WorkTask | null> {
    await this.initialize();

    if (input.delete) {
      const deleted = this.tasks.delete(input.id);
      if (!deleted) {
        return null;
      }

      this.updatedAt = now();
      await this.persist();
      return null;
    }

    const existing = this.tasks.get(input.id);
    if (!existing) {
      return null;
    }

    const timestamp = now();
    const nextStatus = input.status ?? existing.status;

    const next: WorkTask = {
      ...existing,
      title: input.title !== undefined ? input.title : existing.title,
      details: input.details !== undefined ? input.details : existing.details,
      status: nextStatus,
      dependencies: input.dependencies !== undefined ? dedupeStrings(input.dependencies) : existing.dependencies,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      blockedReason: this.resolveBlockedReason(nextStatus, input.blockedReason, existing.blockedReason),
      updatedAt: timestamp,
      completedAt: nextStatus === 'completed'
        ? (existing.completedAt ?? timestamp)
        : undefined
    };

    this.tasks.set(input.id, next);
    this.updatedAt = timestamp;
    await this.persist();

    return next;
  }

  async snapshot(options?: ListTaskOptions): Promise<WorkTaskListSnapshot> {
    const tasks = await this.listTasks(options);

    return {
      taskListId: this.taskListId,
      storagePath: this.storagePath,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      total: tasks.length,
      tasks
    };
  }

  private resolveBlockedReason(status: TaskStatus, blockedReasonInput: string | undefined, previous?: string): string | undefined {
    if (status !== 'blocked') {
      return undefined;
    }

    if (blockedReasonInput !== undefined) {
      return blockedReasonInput || 'Blocked without reason';
    }

    return previous ?? 'Blocked without reason';
  }

  private async loadTaskList(taskListId: string): Promise<void> {
    const normalized = normalizeTaskListId(taskListId);

    this.taskListId = normalized;
    this.storagePath = path.join(this.storageDir, `${normalized}.json`);

    await fs.mkdir(this.storageDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TaskListStoreFile>;

      const parsedTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      this.tasks = new Map(parsedTasks.filter((task): task is WorkTask => !!task?.id).map((task) => [task.id, task]));
      this.createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : now();
      this.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      const timestamp = now();
      this.tasks = new Map();
      this.createdAt = timestamp;
      this.updatedAt = timestamp;
      await this.persist();
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    const payload: TaskListStoreFile = {
      taskListId: this.taskListId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt)
    };

    await fs.writeFile(this.storagePath, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

function buildTaskCreateTool(service: TaskListService): Tool {
  return {
    name: 'task_create',
    description: 'Create one or more tracked tasks for complex work. Use this when work has multiple steps, dependencies, or blockers.',
    inputSchema: TASK_CREATE_INPUT_SCHEMA,
    execute: async ({ tasks, title, details, status, dependencies, blockedReason, metadata }) => {
      const items: CreateTaskInput[] = tasks?.length
        ? tasks
        : [{ title: title!, details, status, dependencies, blockedReason, metadata }];

      const created = await service.createTasks(items);

      return {
        taskListId: service.taskListId,
        storagePath: service.storagePath,
        createdCount: created.length,
        tasks: created
      };
    }
  };
}

function buildTaskGetTool(service: TaskListService): Tool {
  return {
    name: 'task_get',
    description: 'Get full details for a single task by task ID.',
    inputSchema: TASK_GET_INPUT_SCHEMA,
    execute: async ({ id }) => {
      const task = await service.getTask(id);
      if (!task) {
        throw new Error(`Task not found: ${id}`);
      }

      return {
        taskListId: service.taskListId,
        storagePath: service.storagePath,
        task
      };
    }
  };
}

function buildTaskListTool(service: TaskListService): Tool {
  return {
    name: 'task_list',
    description: 'List tasks and their current status. Use this to check progress before and after major changes.',
    inputSchema: TASK_LIST_INPUT_SCHEMA,
    execute: async ({ statuses, includeCompleted, limit }) => {
      const snapshot = await service.snapshot({ statuses, includeCompleted, limit });
      const completed = snapshot.tasks.filter((task) => task.status === 'completed').length;
      const inProgress = snapshot.tasks.filter((task) => task.status === 'in_progress').length;
      const pending = snapshot.tasks.filter((task) => task.status === 'pending').length;
      const blocked = snapshot.tasks.filter((task) => task.status === 'blocked').length;

      return {
        ...snapshot,
        summary: {
          total: snapshot.total,
          completed,
          inProgress,
          pending,
          blocked
        }
      };
    }
  };
}



function buildTaskUpdateTool(service: TaskListService): Tool {
  return {
    name: 'task_update',
    description: 'Update task fields, move status (pending/in_progress/completed/blocked), or delete tasks.',
    inputSchema: TASK_UPDATE_INPUT_SCHEMA,
    execute: async (input) => {
      const task = await service.updateTask(input);

      if (input.delete) {
        return {
          taskListId: service.taskListId,
          storagePath: service.storagePath,
          deleted: true,
          id: input.id
        };
      }

      if (!task) {
        throw new Error(`Task not found: ${input.id}`);
      }

      return {
        taskListId: service.taskListId,
        storagePath: service.storagePath,
        deleted: false,
        task
      };
    }
  };
}

export const builtInTaskTrackingPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-task-tracking',
  version: '1.0.0',
  dependencies: ['pulse-coder-engine/built-in-skills'],

  async initialize(context: EnginePluginContext): Promise<void> {
    const service = new TaskListService();
    await service.initialize();

    context.registerService('taskListService', service);
    context.registerService('taskTracking', service);

    const skillRegistry = context.getService<BuiltInSkillRegistry>('skillRegistry');
    if (skillRegistry) {
      const registration = skillRegistry.registerSkill(TASK_TRACKING_SKILL);
      context.logger.info('[TaskTracking] Registered built-in task tracking skill', registration);
    } else {
      context.logger.warn('[TaskTracking] skillRegistry service unavailable; skipped task tracking skill registration');
    }

    context.registerTools({
      task_create: buildTaskCreateTool(service),
      task_get: buildTaskGetTool(service),
      task_list: buildTaskListTool(service),
      task_update: buildTaskUpdateTool(service)
    });

    context.logger.info('[TaskTracking] Registered task tools', {
      taskListId: service.taskListId,
      storagePath: service.storagePath,
      skillRegistryAvailable: !!skillRegistry
    });
  }
};

export default builtInTaskTrackingPlugin;

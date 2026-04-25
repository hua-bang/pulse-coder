import { z } from 'zod';
import type { Mailbox } from './mailbox.js';
import type { TaskList } from './task-list.js';

/**
 * Context every team-tool implementation needs.
 * Bound once per teammate when the tools are constructed.
 */
export interface TeamToolContext {
  teammateId: string;
  mailbox: Mailbox;
  taskList: TaskList;
  /** Whether the teammate is currently in plan mode (gates `team_submit_plan`). */
  requirePlanApproval?: boolean;
}

/**
 * JSON-schema-ish description used by the mailbox-MCP server.
 * Mirrors the zod schemas below 1:1 so the LLM client gets identical semantics
 * whether the runtime is in-process (pulse) or out-of-process (claude/codex).
 */
export interface MailboxToolJsonSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Single source of truth for the team tool surface. */
export const TEAM_TOOL_SCHEMAS: MailboxToolJsonSchema[] = [
  {
    name: 'team_send_message',
    description: 'Send a message to another teammate by their ID.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient teammate ID' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_read_messages',
    description: 'Read unread messages from the team mailbox.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_list_tasks',
    description: 'List all tasks in the shared task list with their status and assignee.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'team_claim_task',
    description: 'Claim an available pending task. Optionally specify a task ID, or auto-claim the next available one.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Specific task ID to claim, or omit for auto-claim' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'team_complete_task',
    description: 'Mark a task as completed with an optional result summary.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to complete' },
        result: { type: 'string', description: 'Task result or summary' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_create_task',
    description: 'Create a new task in the shared task list.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed description' },
        deps: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of dependency tasks',
        },
        assignee: { type: 'string', description: 'Teammate ID to assign to' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_notify_lead',
    description: 'Send a message to the team lead (e.g. to report findings, ask questions, or signal completion).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Message to the lead' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_submit_plan',
    description: 'Submit your plan to the lead for approval. Use this when you have finished planning and want to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Your detailed implementation plan' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
];

/**
 * Backend-agnostic dispatcher: every team tool routes through here.
 * Used by both the pulse engine tool wrappers and the mailbox-MCP server.
 *
 * Returns the user-facing string the LLM should see as the tool result.
 * Throws on programmer errors (bad tool name); returns string for tool failures.
 */
export async function callTeamTool(
  ctx: TeamToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'team_send_message': {
      const { to, content } = args as { to: string; content: string };
      const msg = ctx.mailbox.send(ctx.teammateId, to, 'message', content);
      return `Message sent to ${to} (id: ${msg.id})`;
    }
    case 'team_read_messages': {
      const messages = ctx.mailbox.readUnread(ctx.teammateId);
      if (messages.length === 0) return 'No unread messages.';
      return messages
        .map(m => `[from: ${m.from}] (${m.type}) ${m.content}`)
        .join('\n---\n');
    }
    case 'team_list_tasks': {
      const tasks = ctx.taskList.getAll();
      if (tasks.length === 0) return 'No tasks.';
      return tasks
        .map(
          t =>
            `[${t.status}] ${t.title} (id: ${t.id}, assignee: ${t.assignee || 'none'})`,
        )
        .join('\n');
    }
    case 'team_claim_task': {
      const { taskId } = args as { taskId?: string };
      const task = await ctx.taskList.claim(ctx.teammateId, taskId);
      if (!task) return 'No claimable task available.';
      return `Claimed task: ${task.title} (id: ${task.id})\nDescription: ${task.description}`;
    }
    case 'team_complete_task': {
      const { taskId, result } = args as { taskId: string; result?: string };
      const task = await ctx.taskList.complete(taskId, result);
      if (!task) return 'Task not found or not in progress.';
      return `Task completed: ${task.title}`;
    }
    case 'team_create_task': {
      const { title, description, deps, assignee } = args as {
        title: string;
        description: string;
        deps?: string[];
        assignee?: string;
      };
      const task = await ctx.taskList.create(
        { title, description, deps, assignee },
        ctx.teammateId,
      );
      return `Task created: ${task.title} (id: ${task.id})`;
    }
    case 'team_notify_lead': {
      const { content } = args as { content: string };
      ctx.mailbox.send(ctx.teammateId, 'lead', 'message', content);
      return 'Message sent to lead.';
    }
    case 'team_submit_plan': {
      if (!ctx.requirePlanApproval) {
        return 'team_submit_plan is only available when requirePlanApproval is enabled.';
      }
      const { plan } = args as { plan: string };
      ctx.mailbox.send(ctx.teammateId, 'lead', 'plan_approval_request', plan);
      return 'Plan submitted to lead for approval. Waiting for response...';
    }
    default:
      throw new Error(`Unknown team tool: ${name}`);
  }
}

/**
 * Build a tool record consumable by pulse `Engine` (zod input schemas + execute).
 * In-process variant — ClaudeCode/Codex receive the same tools via the MCP server.
 */
export function createPulseTeamTools(ctx: TeamToolContext): Record<string, any> {
  const tools: Record<string, any> = {
    team_send_message: {
      name: 'team_send_message',
      description: 'Send a message to another teammate by their ID.',
      inputSchema: z.object({
        to: z.string().describe('Recipient teammate ID'),
        content: z.string().describe('Message content'),
      }),
      execute: async (input: { to: string; content: string }) =>
        callTeamTool(ctx, 'team_send_message', input),
    },
    team_read_messages: {
      name: 'team_read_messages',
      description: 'Read unread messages from the team mailbox.',
      inputSchema: z.object({}),
      execute: async () => callTeamTool(ctx, 'team_read_messages', {}),
    },
    team_list_tasks: {
      name: 'team_list_tasks',
      description:
        'List all tasks in the shared task list with their status and assignee.',
      inputSchema: z.object({}),
      execute: async () => callTeamTool(ctx, 'team_list_tasks', {}),
    },
    team_claim_task: {
      name: 'team_claim_task',
      description:
        'Claim an available pending task. Optionally specify a task ID, or auto-claim the next available one.',
      inputSchema: z.object({
        taskId: z
          .string()
          .optional()
          .describe('Specific task ID to claim, or omit for auto-claim'),
      }),
      execute: async (input: { taskId?: string }) =>
        callTeamTool(ctx, 'team_claim_task', input),
    },
    team_complete_task: {
      name: 'team_complete_task',
      description: 'Mark a task as completed with an optional result summary.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID to complete'),
        result: z.string().optional().describe('Task result or summary'),
      }),
      execute: async (input: { taskId: string; result?: string }) =>
        callTeamTool(ctx, 'team_complete_task', input),
    },
    team_create_task: {
      name: 'team_create_task',
      description: 'Create a new task in the shared task list.',
      inputSchema: z.object({
        title: z.string().describe('Short task title'),
        description: z.string().describe('Detailed description'),
        deps: z.array(z.string()).optional().describe('IDs of dependency tasks'),
        assignee: z.string().optional().describe('Teammate ID to assign to'),
      }),
      execute: async (input: {
        title: string;
        description: string;
        deps?: string[];
        assignee?: string;
      }) => callTeamTool(ctx, 'team_create_task', input),
    },
    team_notify_lead: {
      name: 'team_notify_lead',
      description:
        'Send a message to the team lead (e.g. to report findings, ask questions, or signal completion).',
      inputSchema: z.object({
        content: z.string().describe('Message to the lead'),
      }),
      execute: async (input: { content: string }) =>
        callTeamTool(ctx, 'team_notify_lead', input),
    },
  };

  if (ctx.requirePlanApproval) {
    tools.team_submit_plan = {
      name: 'team_submit_plan',
      description:
        'Submit your plan to the lead for approval. Use this when you have finished planning and want to proceed.',
      inputSchema: z.object({
        plan: z.string().describe('Your detailed implementation plan'),
      }),
      execute: async (input: { plan: string }) =>
        callTeamTool(ctx, 'team_submit_plan', input),
    };
  }

  return tools;
}

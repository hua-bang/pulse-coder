import { z } from 'zod';

import type { Tool, ToolExecutionContext } from './engine-types.js';

import type { AcpBridgeService } from './client.js';

function readRunContextString(runContext: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!runContext) {
    return undefined;
  }

  const value = runContext[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function resolveRunContextSessionId(context?: ToolExecutionContext): string {
  const runContext = context?.runContext as Record<string, unknown> | undefined;
  const sessionId = readRunContextString(runContext, 'sessionId') ?? readRunContextString(runContext, 'session_id');
  if (!sessionId) {
    throw new Error('ACP tools require runContext.sessionId.');
  }
  return sessionId;
}

function buildAcpMetadata(
  runContext: Record<string, unknown> | undefined,
  inputMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(inputMetadata ?? {}),
  };
}

const metadataSchema = z.record(z.string(), z.unknown()).optional();

const statusSchema = z.object({});
const bindSchema = z.object({
  target: z.string().min(1).optional().describe('Target agent for this ACP session, for example codex or claude-code.'),
  metadata: metadataSchema.describe('Optional ACP metadata payload.'),
  forceNewSession: z.boolean().optional().describe('If true, always create a fresh ACP session and replace current binding.'),
});
const promptSchema = z.object({
  prompt: z.string().min(1).describe('Prompt content sent to the bound ACP session.'),
  target: z.string().min(1).optional().describe('Optional target agent override for session binding.'),
  metadata: metadataSchema.describe('Optional ACP metadata payload.'),
  forceNewSession: z.boolean().optional().describe('If true, create a fresh ACP session before sending this prompt.'),
});
const cancelSchema = z.object({
  target: z.string().min(1).optional().describe('Optional target agent override for canceling the ACP session.'),
  reason: z.string().optional().describe('Optional cancel reason for ACP session/cancel.'),
  dropBinding: z.boolean().optional().describe('When true, remove local session binding after cancel succeeds.'),
});

type StatusInput = z.infer<typeof statusSchema>;
type BindInput = z.infer<typeof bindSchema>;
type PromptInput = z.infer<typeof promptSchema>;
type CancelInput = z.infer<typeof cancelSchema>;

function createAcpStatusTool(service: AcpBridgeService): Tool<StatusInput, {
  ok: true;
  configured: boolean;
  transport: string;
  baseUrl?: string;
  command?: string;
  timeoutMs: number;
  defaultTarget: string;
  targets?: string[];
  configuredTargets?: string[];
}> {
  return {
    name: 'acp_status',
    description: 'Check ACP bridge readiness and defaults.',
    defer_loading: true,
    inputSchema: statusSchema,
    execute: async () => {
      const status = service.getStatus();
      return {
        ok: true,
        configured: status.configured,
        transport: status.transport,
        baseUrl: status.baseUrl,
        command: status.command,
        timeoutMs: status.timeoutMs,
        defaultTarget: status.defaultTarget,
        targets: status.targets,
        configuredTargets: status.configuredTargets,
      };
    },
  };
}

function createAcpSessionBindTool(service: AcpBridgeService): Tool<BindInput, {
  ok: true;
  remoteSessionId: string;
  acpSessionId: string;
  target: string;
  reusedSession: boolean;
}> {
  return {
    name: 'acp_session_bind',
    description: 'Create or reuse an ACP session bound to current run session.',
    defer_loading: true,
    inputSchema: bindSchema,
    execute: async (input, context) => {
      const runContext = context?.runContext as Record<string, unknown> | undefined;
      const remoteSessionId = resolveRunContextSessionId(context);
      const ensured = await service.ensureBoundSession({
        remoteSessionId,
        target: input.target,
        metadata: buildAcpMetadata(runContext, input.metadata),
        forceNewSession: input.forceNewSession,
      });

      return {
        ok: true,
        remoteSessionId,
        acpSessionId: ensured.binding.acpSessionId,
        target: ensured.binding.target,
        reusedSession: ensured.reused,
      };
    },
  };
}

function createAcpPromptTool(service: AcpBridgeService): Tool<PromptInput, {
  ok: true;
  remoteSessionId: string;
  acpSessionId: string;
  target: string;
  reusedSession: boolean;
  finishReason?: string;
  text: string;
}> {
  return {
    name: 'acp_prompt',
    description: 'Send prompt to ACP-bound target agent (for example Codex or Claude Code).',
    defer_loading: true,
    inputSchema: promptSchema,
    execute: async (input, context) => {
      const runContext = context?.runContext as Record<string, unknown> | undefined;
      const remoteSessionId = resolveRunContextSessionId(context);
      const prompted = await service.promptWithBoundSession({
        remoteSessionId,
        prompt: input.prompt,
        target: input.target,
        metadata: buildAcpMetadata(runContext, input.metadata),
        forceNewSession: input.forceNewSession,
      });

      return {
        ok: true,
        remoteSessionId,
        acpSessionId: prompted.binding.acpSessionId,
        target: prompted.binding.target,
        reusedSession: prompted.reusedSession,
        finishReason: prompted.finishReason,
        text: prompted.text,
      };
    },
  };
}

function createAcpCancelTool(service: AcpBridgeService): Tool<CancelInput, {
  ok: true;
  remoteSessionId: string;
  foundBinding: boolean;
  canceled: boolean;
  droppedBinding: boolean;
  target?: string;
}> {
  return {
    name: 'acp_cancel',
    description: 'Cancel ACP session mapped to current run session.',
    defer_loading: true,
    inputSchema: cancelSchema,
    execute: async (input, context) => {
      const remoteSessionId = resolveRunContextSessionId(context);
      const canceled = await service.cancelBoundSession({
        remoteSessionId,
        target: input.target,
        reason: input.reason,
        dropBinding: input.dropBinding,
      });

      return {
        ok: true,
        remoteSessionId,
        foundBinding: canceled.found,
        canceled: canceled.canceled,
        droppedBinding: Boolean(input.dropBinding && canceled.found),
        target: canceled.binding?.target,
      };
    },
  };
}

export function createAcpTools(service: AcpBridgeService): Record<string, Tool<any, any>> {
  return {
    acp_status: createAcpStatusTool(service),
    acp_session_bind: createAcpSessionBindTool(service),
    acp_prompt: createAcpPromptTool(service),
    acp_cancel: createAcpCancelTool(service),
  };
}

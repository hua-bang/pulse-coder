import { z } from 'zod';

import type { Tool } from '../../shared/types';

import { buildAcpMetadata, resolveRunContextSessionId } from './context';
import type { AcpBridgeService } from './service';

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
  baseUrl?: string;
  timeoutMs: number;
  defaultTarget: string;
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
        baseUrl: status.baseUrl,
        timeoutMs: status.timeoutMs,
        defaultTarget: status.defaultTarget,
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
        reason: input.reason,
        dropBinding: input.dropBinding,
      });

      return {
        ok: true,
        remoteSessionId,
        foundBinding: canceled.found,
        canceled: canceled.canceled,
        droppedBinding: Boolean(input.dropBinding && canceled.found),
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

import z from 'zod';
import type { EnginePlugin, EnginePluginContext, Tool, ToolExecutionContext } from 'pulse-coder-engine';
import { AcpHttpClient } from './client.js';
import { AcpSessionStore, type AcpSessionBinding } from './session-store.js';

const ACP_SERVICE_NAME = 'acpBridgeService';
const DEFAULT_TARGET = 'codex';

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

function buildMetadata(
  runContext: Record<string, unknown> | undefined,
  inputMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...(inputMetadata ?? {}),
  };

  const sessionId = readRunContextString(runContext, 'sessionId') ?? readRunContextString(runContext, 'session_id');
  const platformKey = readRunContextString(runContext, 'platformKey');
  const ownerKey = readRunContextString(runContext, 'ownerKey');

  if (sessionId) {
    metadata.remoteSessionId = sessionId;
  }
  if (platformKey) {
    metadata.platformKey = platformKey;
  }
  if (ownerKey) {
    metadata.ownerKey = ownerKey;
  }

  return metadata;
}

export interface EnsureSessionInput {
  remoteSessionId: string;
  target?: string;
  metadata?: Record<string, unknown>;
  forceNewSession?: boolean;
}

interface EnsureSessionResult {
  binding: AcpSessionBinding;
  reused: boolean;
}

export class AcpBridgeService {
  private readonly client: AcpHttpClient;

  private readonly sessionStore: AcpSessionStore;

  private readonly defaultTarget: string;

  constructor(input: {
    client: AcpHttpClient;
    sessionStore: AcpSessionStore;
    defaultTarget: string;
  }) {
    this.client = input.client;
    this.sessionStore = input.sessionStore;
    this.defaultTarget = input.defaultTarget;
  }

  getStatus(): { configured: boolean; baseUrl?: string; timeoutMs: number; defaultTarget: string } {
    const status = this.client.getStatus();
    return {
      ...status,
      defaultTarget: this.defaultTarget,
    };
  }

  async ensureBoundSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    this.assertConfigured();
    const existing = await this.sessionStore.get(input.remoteSessionId);
    const requestedTarget = this.resolveTarget(input.target, existing?.target);

    if (existing && !input.forceNewSession && existing.target === requestedTarget) {
      return { binding: existing, reused: true };
    }

    const created = await this.client.createSession({
      target: requestedTarget,
      metadata: input.metadata,
    });

    const binding = await this.sessionStore.upsert({
      remoteSessionId: input.remoteSessionId,
      acpSessionId: created.sessionId,
      target: requestedTarget,
      metadata: input.metadata,
    });

    return {
      binding,
      reused: false,
    };
  }

  async promptWithBoundSession(input: {
    remoteSessionId: string;
    prompt: string;
    target?: string;
    metadata?: Record<string, unknown>;
    forceNewSession?: boolean;
  }): Promise<{
    binding: AcpSessionBinding;
    reusedSession: boolean;
    text: string;
    finishReason?: string;
    raw: unknown;
  }> {
    const session = await this.ensureBoundSession({
      remoteSessionId: input.remoteSessionId,
      target: input.target,
      metadata: input.metadata,
      forceNewSession: input.forceNewSession,
    });

    const prompted = await this.client.prompt({
      sessionId: session.binding.acpSessionId,
      prompt: input.prompt,
      target: session.binding.target,
      metadata: input.metadata,
    });

    return {
      binding: session.binding,
      reusedSession: session.reused,
      text: prompted.text,
      finishReason: prompted.finishReason,
      raw: prompted.raw,
    };
  }

  async cancelBoundSession(input: {
    remoteSessionId: string;
    reason?: string;
    dropBinding?: boolean;
  }): Promise<{
    found: boolean;
    canceled: boolean;
    binding?: AcpSessionBinding;
    raw?: unknown;
  }> {
    this.assertConfigured();
    const binding = await this.sessionStore.get(input.remoteSessionId);
    if (!binding) {
      return {
        found: false,
        canceled: false,
      };
    }

    const canceled = await this.client.cancel({
      sessionId: binding.acpSessionId,
      reason: input.reason,
    });

    if (input.dropBinding) {
      await this.sessionStore.remove(input.remoteSessionId);
    }

    return {
      found: true,
      canceled: true,
      binding,
      raw: canceled.raw,
    };
  }

  private resolveTarget(primary?: string, fallback?: string): string {
    const fromPrimary = primary?.trim();
    if (fromPrimary) {
      return fromPrimary;
    }

    const fromFallback = fallback?.trim();
    if (fromFallback) {
      return fromFallback;
    }

    const fromDefault = this.defaultTarget.trim();
    if (fromDefault) {
      return fromDefault;
    }

    throw new Error('ACP target is missing. Provide target or set ACP_DEFAULT_TARGET.');
  }

  private assertConfigured(): void {
    if (!this.client.isConfigured()) {
      throw new Error('ACP bridge is not configured. Set ACP_BRIDGE_BASE_URL first.');
    }
  }
}

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
    description: 'Create or reuse an ACP session bound to current remote session.',
    defer_loading: true,
    inputSchema: bindSchema,
    execute: async (input, context) => {
      const runContext = context?.runContext as Record<string, unknown> | undefined;
      const remoteSessionId = resolveRunContextSessionId(context);
      const ensured = await service.ensureBoundSession({
        remoteSessionId,
        target: input.target,
        metadata: buildMetadata(runContext, input.metadata),
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
    description: 'Send prompt to ACP-bound target agent (Codex/Claude Code).',
    defer_loading: true,
    inputSchema: promptSchema,
    execute: async (input, context) => {
      const runContext = context?.runContext as Record<string, unknown> | undefined;
      const remoteSessionId = resolveRunContextSessionId(context);
      const prompted = await service.promptWithBoundSession({
        remoteSessionId,
        prompt: input.prompt,
        target: input.target,
        metadata: buildMetadata(runContext, input.metadata),
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
    description: 'Cancel ACP session mapped to current remote session.',
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

export function createAcpBridgeIntegrationFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enginePlugin: EnginePlugin;
  service: AcpBridgeService;
} {
  const client = AcpHttpClient.fromEnv(env);
  const sessionStorePath = env.ACP_SESSION_STORE_PATH?.trim();
  const sessionStore = sessionStorePath ? new AcpSessionStore(sessionStorePath) : new AcpSessionStore();
  const defaultTarget = env.ACP_DEFAULT_TARGET?.trim() || DEFAULT_TARGET;
  const service = new AcpBridgeService({
    client,
    sessionStore,
    defaultTarget,
  });

  const enginePlugin: EnginePlugin = {
    name: 'remote-acp-bridge',
    version: '0.1.0',
    async initialize(context: EnginePluginContext) {
      await sessionStore.initialize();

      context.registerService(ACP_SERVICE_NAME, service);
      context.registerTool('acp_status', createAcpStatusTool(service));
      context.registerTool('acp_session_bind', createAcpSessionBindTool(service));
      context.registerTool('acp_prompt', createAcpPromptTool(service));
      context.registerTool('acp_cancel', createAcpCancelTool(service));

      const status = service.getStatus();
      context.logger.info(
        `[acp] plugin ready configured=${status.configured} baseUrl=${status.baseUrl ?? '(unset)'} defaultTarget=${status.defaultTarget}`,
      );
    },
  };

  return {
    enginePlugin,
    service,
  };
}

export const acpBridgeIntegration = createAcpBridgeIntegrationFromEnv(process.env);

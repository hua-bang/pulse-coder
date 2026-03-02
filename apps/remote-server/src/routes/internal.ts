import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createLarkClient, sendImageMessage, sendTextMessage } from '../adapters/feishu/client.js';
import { extractGeminiImageResult } from '../adapters/feishu/image-result.js';
import { getDiscordGatewayStatus, restartDiscordGateway } from '../adapters/discord/gateway-manager.js';
import { DiscordClient } from '../adapters/discord/client.js';
import { executeAgentTurn, formatCompactionEvents, type CompactionSnapshot } from '../core/agent-runner.js';
import type { ClarificationRequest } from '../core/types.js';

type ReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email';

type AskPolicy = 'never' | 'default';

interface FeishuNotifyConfig {
  receiveId?: string;
  receiveIdType?: ReceiveIdType;
}

interface DiscordNotifyConfig {
  channelId?: string;
  isThread?: boolean;
}

interface NotifyConfig {
  feishu?: FeishuNotifyConfig;
  discord?: DiscordNotifyConfig;
}

interface AgentRunBody {
  platformKey?: string;
  text?: string;
  message?: string;
  prompt?: string;
  skill?: string;
  forceNewSession?: boolean;
  askPolicy?: AskPolicy;
  notify?: NotifyConfig;
}

interface NotifyResult {
  ok: boolean;
  skipped: boolean;
  error?: string;
}

interface ToolCallSnapshot {
  name: string;
  input: unknown;
}

interface FeishuTarget {
  receiveId: string;
  receiveIdType: ReceiveIdType;
}

interface DiscordTarget {
  channelId: string;
  isThread: boolean;
}

const DEFAULT_PLATFORM_KEY = 'internal:agent-run';
const DEFAULT_SKILL_PROMPT = 'Please execute this skill and return the final result.';
const DEFAULT_ASK_POLICY: AskPolicy = 'never';

export const internalRouter = new Hono();

internalRouter.use('*', async (c, next) => {
  if (!isLocalInternalRequest(c)) {
    return c.json({ ok: false, error: 'Forbidden: local requests only' }, 403);
  }

  await next();
});


internalRouter.get('/discord/gateway/status', (c) => {
  if (!verifyInternalAuth(c.req.header('authorization'), c.req.header('x-internal-api-key'))) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const status = getDiscordGatewayStatus();
  return c.json({ ok: true, gateway: status }, 200);
});

internalRouter.post('/discord/gateway/restart', (c) => {
  if (!verifyInternalAuth(c.req.header('authorization'), c.req.header('x-internal-api-key'))) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const status = restartDiscordGateway();
  return c.json({ ok: true, restarted: true, gateway: status }, 200);
});

internalRouter.post('/agent/run', async (c) => {
  if (!verifyInternalAuth(c.req.header('authorization'), c.req.header('x-internal-api-key'))) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let body: AgentRunBody;
  try {
    body = await c.req.json<AgentRunBody>();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const runId = randomUUID();
  const platformKey = normalizePlatformKey(body.platformKey);
  const askPolicy = normalizeAskPolicy(body.askPolicy);
  const forceNewSession = body.forceNewSession ?? true;
  const text = buildPromptText(body);

  if (!text) {
    return c.json(
      {
        ok: false,
        error: 'Missing prompt. Provide one of: text, message, prompt, or skill.',
      },
      400,
    );
  }

  let sessionId = '';
  const toolCalls: ToolCallSnapshot[] = [];
  const compactions: CompactionSnapshot[] = [];
  const clarifications: Array<{ id: string; usedDefault: boolean }> = [];
  const feishuTarget = resolveFeishuTarget(body.notify?.feishu, platformKey);
  const discordTarget = resolveDiscordTarget(body.notify?.discord, platformKey);
  const sentImagePaths = new Set<string>();
  const imageNotifyTasks: Promise<void>[] = [];

  try {
    const turn = await executeAgentTurn({
      platformKey,
      memoryKey: platformKey,
      forceNewSession,
      userText: text,
      source: 'internal',
      callbacks: {
        onToolCall: (toolCall) => {
          const name = toolCall.toolName ?? toolCall.name ?? 'unknown';
          const input = toolCall.args ?? toolCall.input ?? {};
          toolCalls.push({ name, input });
        },
        onToolResult: (toolResult) => {
          if (!feishuTarget) {
            return;
          }

          const imageResult = extractGeminiImageResult(toolResult);
          if (!imageResult) {
            return;
          }

          if (!existsSync(imageResult.outputPath) || sentImagePaths.has(imageResult.outputPath)) {
            return;
          }

          sentImagePaths.add(imageResult.outputPath);
          imageNotifyTasks.push(
            sendImageMessage(
              feishuTarget.receiveId,
              feishuTarget.receiveIdType,
              imageResult.outputPath,
              imageResult.mimeType,
            )
              .then(() => undefined)
              .catch((err) => {
                console.error('[internal] Failed to send generated image to Feishu:', err);
              }),
          );
        },
        onClarificationRequest: async (request: ClarificationRequest) => {
          const answer = resolveClarificationAnswer(request, askPolicy);
          clarifications.push({ id: request.id, usedDefault: request.defaultAnswer !== undefined });
          return answer;
        },
      },
    });

    sessionId = turn.sessionId;
    compactions.push(...turn.compactions);

    await Promise.allSettled(imageNotifyTasks);

    if (compactions.length > 0) {
      console.info(
        `[internal] compacted ${platformKey} session=${sessionId} details=${formatCompactionEvents(compactions)}`,
      );
    }

    const notifyResult = await sendOptionalNotification(body.notify, {
      runId,
      platformKey,
      skill: body.skill,
      sessionId,
      ok: true,
      result: turn.resultText,
    }, { feishuTarget, discordTarget });

    return c.json({
      ok: true,
      runId,
      platformKey,
      sessionId,
      requestText: text,
      result: turn.resultText,
      toolCalls,
      compactionCount: compactions.length,
      compactions,
      clarificationCount: clarifications.length,
      notify: notifyResult,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    await Promise.allSettled(imageNotifyTasks);

    const notifyResult = await sendOptionalNotification(body.notify, {
      runId,
      platformKey,
      skill: body.skill,
      sessionId,
      ok: false,
      result: error,
    }, { feishuTarget, discordTarget });

    return c.json(
      {
        ok: false,
        runId,
        platformKey,
        sessionId,
        requestText: text,
        error,
        toolCalls,
        compactionCount: compactions.length,
        compactions,
        clarificationCount: clarifications.length,
        notify: notifyResult,
      },
      500,
    );
  }
});

function isLocalInternalRequest(c: Context): boolean {
  const connInfo = getConnInfo(c);
  return isLoopbackAddress(connInfo.remote.address);
}

function isLoopbackAddress(address?: string): boolean {
  if (!address) {
    return false;
  }

  const normalized = address.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function verifyInternalAuth(authHeader?: string, internalApiKey?: string): boolean {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    return process.env.NODE_ENV !== 'production';
  }

  if (authHeader === `Bearer ${secret}`) {
    return true;
  }

  if (internalApiKey === secret) {
    return true;
  }

  return false;
}

function normalizePlatformKey(value?: string): string {
  if (!value) {
    return DEFAULT_PLATFORM_KEY;
  }

  const normalized = value.trim();
  return normalized || DEFAULT_PLATFORM_KEY;
}

function normalizeAskPolicy(value?: string): AskPolicy {
  return value === 'default' ? 'default' : DEFAULT_ASK_POLICY;
}

function buildPromptText(body: AgentRunBody): string | null {
  const raw = firstNonEmpty(body.text, body.message, body.prompt);
  const normalizedRaw = raw ? normalizeSkillDirective(raw) : '';

  if (body.skill && body.skill.trim()) {
    if (normalizedRaw && looksLikeSkillPrompt(normalizedRaw)) {
      return normalizedRaw;
    }

    const skillName = body.skill.trim();
    const prompt = normalizedRaw || DEFAULT_SKILL_PROMPT;
    return `[use skill](${skillName}) ${prompt}`;
  }

  return normalizedRaw || null;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return '';
}

function looksLikeSkillPrompt(text: string): boolean {
  return /\[use skill\]\([^\)]+\)/i.test(text) || /\[use skill\s+[^\]]+\]/i.test(text);
}

function normalizeSkillDirective(text: string): string {
  return text.replace(/\[use skill\s+([^\]]+)\]/gi, (_match, name: string) => {
    const trimmedName = String(name).trim();
    if (!trimmedName) {
      return '[use skill]';
    }
    return `[use skill](${trimmedName})`;
  });
}

function resolveClarificationAnswer(request: ClarificationRequest, askPolicy: AskPolicy): string {
  if (request.defaultAnswer !== undefined) {
    return request.defaultAnswer;
  }

  if (askPolicy === 'never') {
    return '';
  }

  throw new Error(`Clarification required but no default answer provided: ${request.question}`);
}

async function sendOptionalNotification(
  notify: NotifyConfig | undefined,
  payload: {
    runId: string;
    platformKey: string;
    sessionId: string;
    skill?: string;
    ok: boolean;
    result: string;
  },
  targets: {
    feishuTarget: FeishuTarget | null;
    discordTarget: DiscordTarget | null;
  },
): Promise<NotifyResult> {
  const baseMessage = buildNotifyMessage(payload);
  let hasTarget = false;
  let error: string | undefined;

  if (targets.feishuTarget) {
    hasTarget = true;
    const feishuResult = await sendFeishuNotification(targets.feishuTarget, baseMessage).catch((err) => {
      error = err instanceof Error ? err.message : String(err);
      return false;
    });

    if (!feishuResult && !error) {
      error = 'Feishu notify failed';
    }
  }

  if (targets.discordTarget) {
    hasTarget = true;
    const discordResult = await sendDiscordNotification(targets.discordTarget, baseMessage).catch((err) => {
      error = err instanceof Error ? err.message : String(err);
      return false;
    });

    if (!discordResult && !error) {
      error = 'Discord notify failed';
    }
  }

  if (!hasTarget) {
    return { ok: true, skipped: true };
  }

  if (error) {
    return { ok: false, skipped: false, error };
  }

  return { ok: true, skipped: false };
}

function buildNotifyMessage(payload: {
  runId: string;
  platformKey: string;
  sessionId: string;
  skill?: string;
  ok: boolean;
  result: string;
}): string {
  const title = payload.ok ? '[agent-run] done' : '[agent-run] failed';
  const skillLine = payload.skill ? `skill: ${payload.skill}\n` : '';
  return [
    `${title}`,
    `runId: ${payload.runId}`,
    `platformKey: ${payload.platformKey}`,
    `sessionId: ${payload.sessionId || '(none)'}`,
    `${skillLine}result:`,
    truncateForFeishu(payload.result),
  ].join('\n');
}

async function sendFeishuNotification(target: FeishuTarget, message: string): Promise<boolean> {
  const client = createLarkClient();
  await sendTextMessage(client, target.receiveId, target.receiveIdType, message);
  return true;
}

async function sendDiscordNotification(target: DiscordTarget, message: string): Promise<boolean> {
  const client = new DiscordClient();
  await client.sendChannelMessage(target.channelId, message, { assumeThread: target.isThread });
  return true;
}

function resolveDiscordTarget(discord: DiscordNotifyConfig | undefined, platformKey: string): DiscordTarget | null {
  if (discord?.channelId) {
    return {
      channelId: discord.channelId,
      isThread: discord.isThread ?? false,
    };
  }

  const threadMatch = /^discord:thread:([^:]+)$/.exec(platformKey);
  if (threadMatch) {
    return {
      channelId: threadMatch[1],
      isThread: true,
    };
  }

  const channelMatch = /^discord:channel:([^:]+):[^:]+$/.exec(platformKey);
  if (channelMatch) {
    return {
      channelId: channelMatch[1],
      isThread: false,
    };
  }

  return null;
}

function resolveFeishuTarget(feishu: FeishuNotifyConfig | undefined, platformKey: string): FeishuTarget | null {
  if (!feishu) {
    return null;
  }

  if (feishu.receiveId) {
    return {
      receiveId: feishu.receiveId,
      receiveIdType: feishu.receiveIdType ?? 'open_id',
    };
  }

  const groupMatch = /^feishu:group:([^:]+):[^:]+$/.exec(platformKey);
  if (groupMatch) {
    return {
      receiveId: groupMatch[1],
      receiveIdType: 'chat_id',
    };
  }

  const directMatch = /^feishu:([^:]+)$/.exec(platformKey);
  if (directMatch) {
    return {
      receiveId: directMatch[1],
      receiveIdType: 'open_id',
    };
  }

  return null;
}

function truncateForFeishu(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

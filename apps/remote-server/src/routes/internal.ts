import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { createLarkClient, sendTextMessage } from '../adapters/feishu/client.js';
import { engine } from '../core/engine-singleton.js';
import { sessionStore } from '../core/session-store.js';
import type { ClarificationRequest } from '../core/types.js';

type ReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email';

type AskPolicy = 'never' | 'default';

interface FeishuNotifyConfig {
  receiveId: string;
  receiveIdType?: ReceiveIdType;
}

interface NotifyConfig {
  feishu?: FeishuNotifyConfig;
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

const DEFAULT_PLATFORM_KEY = 'internal:agent-run';
const DEFAULT_SKILL_PROMPT = 'Please execute this skill and return the final result.';
const DEFAULT_ASK_POLICY: AskPolicy = 'never';

export const internalRouter = new Hono();

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
  const clarifications: Array<{ id: string; usedDefault: boolean }> = [];

  try {
    const session = await sessionStore.getOrCreate(platformKey, forceNewSession);
    sessionId = session.sessionId;
    const context = session.context;

    context.messages.push({ role: 'user', content: text });

    const result = await engine.run(context, {
      onToolCall: (toolCall) => {
        const name = toolCall.toolName ?? toolCall.name ?? 'unknown';
        const input = toolCall.args ?? toolCall.input ?? {};
        toolCalls.push({ name, input });
      },
      onResponse: (messages) => {
        for (const msg of messages) {
          context.messages.push(msg);
        }
      },
      onCompacted: (newMessages) => {
        context.messages = newMessages;
      },
      onClarificationRequest: async (request: ClarificationRequest) => {
        const answer = resolveClarificationAnswer(request, askPolicy);
        clarifications.push({ id: request.id, usedDefault: request.defaultAnswer !== undefined });
        return answer;
      },
    });

    await sessionStore.save(sessionId, context);

    const notifyResult = await sendOptionalFeishuNotification(body.notify, {
      runId,
      platformKey,
      skill: body.skill,
      sessionId,
      ok: true,
      result,
    });

    return c.json({
      ok: true,
      runId,
      platformKey,
      sessionId,
      requestText: text,
      result,
      toolCalls,
      clarificationCount: clarifications.length,
      notify: notifyResult,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    const notifyResult = await sendOptionalFeishuNotification(body.notify, {
      runId,
      platformKey,
      skill: body.skill,
      sessionId,
      ok: false,
      result: error,
    });

    return c.json(
      {
        ok: false,
        runId,
        platformKey,
        sessionId,
        requestText: text,
        error,
        toolCalls,
        clarificationCount: clarifications.length,
        notify: notifyResult,
      },
      500,
    );
  }
});

function verifyInternalAuth(authHeader?: string, internalApiKey?: string): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return true;
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

async function sendOptionalFeishuNotification(
  notify: NotifyConfig | undefined,
  payload: {
    runId: string;
    platformKey: string;
    sessionId: string;
    skill?: string;
    ok: boolean;
    result: string;
  },
): Promise<NotifyResult> {
  const feishu = notify?.feishu;
  if (!feishu?.receiveId) {
    return { ok: true, skipped: true };
  }

  const receiveIdType: ReceiveIdType = feishu.receiveIdType ?? 'open_id';

  const title = payload.ok ? '[agent-run] done' : '[agent-run] failed';
  const skillLine = payload.skill ? `skill: ${payload.skill}\n` : '';
  const message = [
    `${title}`,
    `runId: ${payload.runId}`,
    `platformKey: ${payload.platformKey}`,
    `sessionId: ${payload.sessionId || '(none)'}`,
    `${skillLine}result:`,
    truncateForFeishu(payload.result),
  ].join('\n');

  try {
    const client = createLarkClient();
    await sendTextMessage(client, feishu.receiveId, receiveIdType, message);
    return { ok: true, skipped: false };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truncateForFeishu(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

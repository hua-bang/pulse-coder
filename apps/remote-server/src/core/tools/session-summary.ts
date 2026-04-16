import z from 'zod';
import type { Tool } from 'pulse-coder-engine';
import { sessionStore } from '../session-store.js';

const toolSchema = z.object({
  days: z.number().int().min(1).max(30).default(3).describe('Number of days to summarize, counting back from today (UTC).'),
  offsetDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe('Offset the time window by N days from today (UTC). 0 means up to today.'),
  sessionId: z
    .string()
    .optional()
    .describe('Optional explicit session id. Only use a session id from trusted tool output or user input; never invent one.'),
  includeUserMessages: z.boolean().optional().describe('Include user messages in the output. Defaults to true.'),
  includeAssistantMessages: z.boolean().optional().describe('Include assistant messages in the output. Defaults to true.'),
  maxMessagesPerSession: z.number().int().min(5).max(500).optional().describe('Cap message count per session (newest first). Defaults to 200.'),
  scope: z.enum(['platform', 'owner']).optional().describe('Select session scope: platform (current channel) or owner (all channels for the user). Defaults to owner.'),
});

type ToolInput = z.infer<typeof toolSchema>;

type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface SessionMessage {
  role?: MessageRole;
  content?: unknown;
}

interface SessionSummary {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  excerpt: string[];
}

interface ToolResult {
  ok: boolean;
  platformKey: string;
  ownerKey?: string;
  since: string;
  until: string;
  matchedSessions: number;
  sessions: SessionSummary[];
}

const DEFAULT_MAX_MESSAGES = 200;

export const sessionSummaryTool: Tool<ToolInput, ToolResult> = {
  name: 'session_summary',
  description: 'Summarize recent sessions for the current user by reading stored session messages.',
  defer_loading: true,
  inputSchema: toolSchema,
  execute: async (input, context) => {
    const runContext = context?.runContext || {};
    const platformKey = typeof runContext.platformKey === 'string' ? runContext.platformKey : '';
    if (!platformKey) {
      throw new Error('session_summary requires runContext.platformKey');
    }

    const ownerKey = typeof runContext.ownerKey === 'string' ? runContext.ownerKey : undefined;
    const scope = input.scope ?? 'owner';
    const scopePlatformKey = scope === 'owner' && ownerKey ? ownerKey : platformKey;
    const scopeOwnerKey = scope === 'owner' ? ownerKey : undefined;
    const days = input.days ?? 3;
    const offsetDays = input.offsetDays ?? 0;
    const includeUser = input.includeUserMessages !== false;
    const includeAssistant = input.includeAssistantMessages !== false;
    const maxMessages = input.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES;

    const now = new Date();
    const baseDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endDate = new Date(baseDate);
    endDate.setUTCDate(endDate.getUTCDate() - offsetDays);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    const sinceDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
    const untilDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate(), 23, 59, 59, 999));
    const sinceMs = sinceDate.getTime();
    const untilMs = untilDate.getTime();

    let summaries: SessionSummary[] = [];

    if (input.sessionId) {
      const detail = await sessionStore.getSessionDetail(scopePlatformKey, input.sessionId, scopeOwnerKey);
      if (detail) {
        summaries = [buildSessionSummary(detail, includeUser, includeAssistant, maxMessages)];
      } else {
        summaries = await listSummariesForWindow({
          platformKey: scopePlatformKey,
          ownerKey: scopeOwnerKey,
          sinceMs,
          untilMs,
          includeUser,
          includeAssistant,
          maxMessages,
        });
      }
    } else {
      summaries = await listSummariesForWindow({
        platformKey: scopePlatformKey,
        ownerKey: scopeOwnerKey,
        sinceMs,
        untilMs,
        includeUser,
        includeAssistant,
        maxMessages,
      });
    }

    return {
      ok: true,
      platformKey,
      ownerKey,
      since: sinceDate.toISOString().slice(0, 10),
      until: untilDate.toISOString().slice(0, 10),
      matchedSessions: summaries.length,
      sessions: summaries,
    };
  },
};

async function listSummariesForWindow(input: {
  platformKey: string;
  ownerKey?: string;
  sinceMs: number;
  untilMs: number;
  includeUser: boolean;
  includeAssistant: boolean;
  maxMessages: number;
}): Promise<SessionSummary[]> {
  const sessions = await sessionStore.listSessions(input.platformKey, 50, input.ownerKey);
  const candidates = sessions.filter((session) => session.updatedAt >= input.sinceMs && session.updatedAt <= input.untilMs);
  const details = await Promise.all(
    candidates.map((session) => sessionStore.getSessionDetail(input.platformKey, session.id, input.ownerKey)),
  );

  return details
    .filter((detail): detail is NonNullable<typeof detail> => Boolean(detail))
    .map((detail) => buildSessionSummary(detail, input.includeUser, input.includeAssistant, input.maxMessages));
}

function buildSessionSummary(
  session: { id: string; createdAt: number; updatedAt: number; messages: unknown[] },
  includeUser: boolean,
  includeAssistant: boolean,
  maxMessages: number,
): SessionSummary {
  const rawMessages = session.messages || [];
  const filtered = rawMessages
    .map((message) => normalizeMessage(message))
    .filter((message): message is SessionMessage => {
      if (!message) return false;
      if (message.role === 'user') return includeUser;
      if (message.role === 'assistant') return includeAssistant;
      return false;
    })
    .slice(-maxMessages);

  const excerpt = filtered.map((message) => {
    const role = message.role ?? 'unknown';
    const text = summarizeContent(message.content);
    return `${role}: ${text}`.trim();
  });

  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: rawMessages.length,
    excerpt,
  };
}

function normalizeMessage(message: unknown): SessionMessage | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const candidate = message as { role?: unknown; content?: unknown };
  if (typeof candidate.role !== 'string') {
    return null;
  }
  return {
    role: candidate.role as MessageRole,
    content: candidate.content,
  };
}

function summarizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return trimText(content);
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((part) => part.trim().length > 0);
    return trimText(parts.join(' '));
  }

  if (content && typeof content === 'object') {
    try {
      return trimText(JSON.stringify(content));
    } catch {
      return trimText(String(content));
    }
  }

  return trimText(String(content ?? ''));
}

function trimText(text: string, max = 240): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return '(empty)';
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

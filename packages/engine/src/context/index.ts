import { pruneMessages, type ModelMessage } from "ai";
import { summarizeMessages } from "../ai";
import {
  COMPACT_TRIGGER,
  COMPACT_TARGET,
  KEEP_LAST_TURNS,
} from "../config/index";
import type { Context, LLMProviderFactory } from "../shared/types";

export type CompactStats = {
  forced: boolean;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  strategy: 'summary' | 'summary-too-large' | 'fallback';
};

export type CompactResult = {
  didCompact: boolean;
  reason?: string;
  newMessages?: ModelMessage[];
  stats?: CompactStats;
};

const ensureSummaryPrefix = (summary: string): string => {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.startsWith('[COMPACTED_CONTEXT]')) {
    return trimmed;
  }
  return `[COMPACTED_CONTEXT]\n${trimmed}`;
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const estimateTokens = (messages: ModelMessage[]): number => {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += message.role.length;
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else {
      totalChars += safeStringify(message.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
};

const splitByTurns = (messages: ModelMessage[], keepLastTurns: number) => {
  const userIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      userIndices.push(index);
    }
  });

  if (userIndices.length <= keepLastTurns) {
    return { oldMessages: [], recentMessages: messages };
  }

  const cutIndex = userIndices[userIndices.length - keepLastTurns];
  return {
    oldMessages: messages.slice(0, cutIndex),
    recentMessages: messages.slice(cutIndex),
  };
};

const takeLastTurns = (messages: ModelMessage[], keepLastTurns: number): ModelMessage[] => {
  const userIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      userIndices.push(index);
    }
  });

  if (userIndices.length === 0) {
    return messages;
  }

  if (userIndices.length <= keepLastTurns) {
    return messages;
  }

  const startIndex = userIndices[userIndices.length - keepLastTurns];
  return messages.slice(startIndex);
};

type BuildCompactedResultParams = {
  reason: string;
  strategy: CompactStats['strategy'];
  newMessages: ModelMessage[];
  force: boolean;
  beforeMessageCount: number;
  beforeEstimatedTokens: number;
};

const buildCompactedResult = ({
  reason,
  strategy,
  newMessages,
  force,
  beforeMessageCount,
  beforeEstimatedTokens,
}: BuildCompactedResultParams): CompactResult => {
  const afterEstimatedTokens = estimateTokens(newMessages);
  if (afterEstimatedTokens >= beforeEstimatedTokens) {
    return { didCompact: false, reason };
  }

  return {
    didCompact: true,
    reason,
    newMessages,
    stats: {
      forced: force,
      beforeMessageCount,
      afterMessageCount: newMessages.length,
      beforeEstimatedTokens,
      afterEstimatedTokens,
      strategy,
    },
  };
};

export const maybeCompactContext = async (
  context: Context,
  options?: { force?: boolean; provider?: LLMProviderFactory; model?: string }
): Promise<CompactResult> => {
  const { messages } = context;
  if (messages.length === 0) {
    return { didCompact: false };
  }

  const force = Boolean(options?.force);
  const beforeMessageCount = messages.length;
  const beforeEstimatedTokens = estimateTokens(messages);
  if (!force && beforeEstimatedTokens < COMPACT_TRIGGER) {
    return { didCompact: false };
  }

  let { oldMessages, recentMessages } = splitByTurns(messages, KEEP_LAST_TURNS);
  if (oldMessages.length === 0) {
    if (!force) {
      return { didCompact: false };
    }

    // In force mode, still try to compact short conversations:
    // 1) keep the latest user turn when possible;
    // 2) if there is only one user turn, keep the last message.
    const forcedByTurn = splitByTurns(messages, 1);
    oldMessages = forcedByTurn.oldMessages;
    recentMessages = forcedByTurn.recentMessages;

    if (oldMessages.length === 0) {
      if (messages.length <= 1) {
        return { didCompact: false };
      }
      oldMessages = messages.slice(0, -1);
      recentMessages = messages.slice(-1);
    }
  }

  try {
    const summary = await summarizeMessages(oldMessages, {
      provider: options?.provider,
      model: options?.model,
    });
    const summaryText = ensureSummaryPrefix(summary);
    if (!summaryText) {
      throw new Error('Empty summary result');
    }

    const nextMessages: ModelMessage[] = [
      { role: 'assistant', content: summaryText },
      ...recentMessages,
    ];

    const nextEstimatedTokens = estimateTokens(nextMessages);
    if (nextEstimatedTokens > COMPACT_TARGET || nextEstimatedTokens >= beforeEstimatedTokens) {
      const fallbackReason = nextEstimatedTokens > COMPACT_TARGET ? 'summary-too-large' : 'summary-no-gain';
      const fallbackStrategy: CompactStats['strategy'] = nextEstimatedTokens > COMPACT_TARGET
        ? 'summary-too-large'
        : 'fallback';
      const fallbackMessages = takeLastTurns(messages, KEEP_LAST_TURNS);
      return buildCompactedResult({
        reason: fallbackReason,
        strategy: fallbackStrategy,
        newMessages: fallbackMessages,
        force,
        beforeMessageCount,
        beforeEstimatedTokens,
      });
    }

    return {
      didCompact: true,
      reason: force ? 'force-summary' : 'summary',
      newMessages: nextMessages,
      stats: {
        forced: force,
        beforeMessageCount,
        afterMessageCount: nextMessages.length,
        beforeEstimatedTokens,
        afterEstimatedTokens: nextEstimatedTokens,
        strategy: 'summary',
      },
    };
  } catch {
    const pruned = pruneMessages({
      messages,
      reasoning: 'all',
      toolCalls: 'all',
      emptyMessages: 'remove',
    });
    const fallbackMessages = takeLastTurns(pruned, KEEP_LAST_TURNS);
    return buildCompactedResult({
      reason: 'fallback',
      strategy: 'fallback',
      newMessages: fallbackMessages,
      force,
      beforeMessageCount,
      beforeEstimatedTokens,
    });
  }
};
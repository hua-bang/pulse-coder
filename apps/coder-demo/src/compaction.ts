import { pruneMessages, type ModelMessage } from "ai";
import { summarizeMessages } from "./ai";
import {
  COMPACT_TRIGGER,
  COMPACT_TARGET,
  KEEP_LAST_TURNS,
} from "./config";
import type { Context } from "./typings";

type CompactResult = {
  didCompact: boolean;
  reason?: string;
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

export const maybeCompactContext = async (
  context: Context,
  options?: { force?: boolean }
): Promise<CompactResult> => {
  const { messages } = context;
  if (messages.length === 0) {
    return { didCompact: false };
  }

  const estimatedTokens = estimateTokens(messages);
  if (!options?.force && estimatedTokens < COMPACT_TRIGGER) {
    return { didCompact: false };
  }

  const { oldMessages, recentMessages } = splitByTurns(messages, KEEP_LAST_TURNS);
  if (oldMessages.length === 0) {
    return { didCompact: false };
  }

  try {
    const summary = await summarizeMessages(oldMessages);
    const summaryText = ensureSummaryPrefix(summary);
    if (!summaryText) {
      throw new Error('Empty summary result');
    }

    const nextMessages: ModelMessage[] = [
      { role: 'assistant', content: summaryText },
      ...recentMessages,
    ];

    if (estimateTokens(nextMessages) > COMPACT_TARGET) {
      context.messages = takeLastTurns(messages, KEEP_LAST_TURNS);
      return { didCompact: true, reason: 'summary-too-large' };
    }

    context.messages = nextMessages;
    return { didCompact: true };
  } catch (error) {
    const pruned = pruneMessages({
      messages,
      reasoning: 'all',
      toolCalls: 'all',
      emptyMessages: 'remove',
    });
    context.messages = takeLastTurns(pruned, KEEP_LAST_TURNS);
    return { didCompact: true, reason: 'fallback' };
  }
};

import dotenv from "dotenv";
import { createOpenAI } from '@ai-sdk/openai';

dotenv.config();

export const CoderAI = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_API_URL || 'https://api.openai.com/v1'
});

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'novita/deepseek/deepseek_v3';

export const MAX_TURNS = 50;

export const MAX_ERROR_COUNT = 3;

export const MAX_STEPS = 25;

export const MAX_TOOL_OUTPUT_LENGTH = 30_000;

export const CONTEXT_WINDOW_TOKENS = Number(process.env.CONTEXT_WINDOW_TOKENS ?? 64_000);

export const COMPACT_TRIGGER = Number(
  process.env.COMPACT_TRIGGER ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.75)
);

export const COMPACT_TARGET = Number(
  process.env.COMPACT_TARGET ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.5)
);

export const KEEP_LAST_TURNS = Number(process.env.KEEP_LAST_TURNS ?? 6);

export const COMPACT_SUMMARY_MAX_TOKENS = Number(
  process.env.COMPACT_SUMMARY_MAX_TOKENS ?? 1200
);

export const MAX_COMPACTION_ATTEMPTS = Number(
  process.env.MAX_COMPACTION_ATTEMPTS ?? 2
);

export const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;

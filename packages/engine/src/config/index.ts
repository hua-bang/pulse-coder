import dotenv from "dotenv";
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from "@ai-sdk/anthropic";
import { LanguageModel } from "ai";

dotenv.config();

export const CoderAI = (process.env.USE_ANTHROPIC
  ? createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseURL: process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1'
  })
  : createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_URL || 'https://api.openai.com/v1'
  }).chat) as (model: string) => LanguageModel;

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || 'novita/deepseek/deepseek_v3';

export const MAX_TURNS = 100;
export const MAX_ERROR_COUNT = 3;
export const MAX_STEPS = 100;
export const MAX_TOOL_OUTPUT_LENGTH = 30_000;

export const CONTEXT_WINDOW_TOKENS = Number(process.env.CONTEXT_WINDOW_TOKENS ?? 64_000);
export const COMPACT_TRIGGER = Number(process.env.COMPACT_TRIGGER ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.75));
export const COMPACT_TARGET = Number(process.env.COMPACT_TARGET ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.5));
export const KEEP_LAST_TURNS = Number(process.env.KEEP_LAST_TURNS ?? 6);
export const COMPACT_SUMMARY_MAX_TOKENS = Number(process.env.COMPACT_SUMMARY_MAX_TOKENS ?? 1200);
export const MAX_COMPACTION_ATTEMPTS = Number(process.env.MAX_COMPACTION_ATTEMPTS ?? 2);
export const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;

// Clarification settings
export const CLARIFICATION_TIMEOUT = Number(process.env.CLARIFICATION_TIMEOUT ?? 300_000); // 5 minutes
export const CLARIFICATION_ENABLED = process.env.CLARIFICATION_ENABLED !== 'false';
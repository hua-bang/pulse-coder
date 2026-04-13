import dotenv from "dotenv";
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from "@ai-sdk/anthropic";
import { LanguageModel } from "ai";
import type { ModelType, LLMProviderFactory } from '../shared/types.js';

dotenv.config();

/**
 * Resolve an environment variable with fallback priority:
 *   project-specific key > global `PULSE_`-prefixed key > fallback
 *
 * This lets users set `PULSE_OPENAI_API_KEY` etc. globally in their shell
 * profile while still allowing any individual project to override via its
 * own `.env` file.
 */
function readEnv(names: string[], fallback = ''): string {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '') return raw;
  }
  return fallback;
}

const OPENAI_API_KEY = readEnv(['OPENAI_API_KEY', 'PULSE_OPENAI_API_KEY']);
const OPENAI_API_URL = readEnv(
  ['OPENAI_API_URL', 'PULSE_OPENAI_API_URL'],
  'https://api.openai.com/v1',
);
const ANTHROPIC_API_KEY = readEnv(['ANTHROPIC_API_KEY', 'PULSE_ANTHROPIC_API_KEY']);
const ANTHROPIC_API_URL = readEnv(
  ['ANTHROPIC_API_URL', 'PULSE_ANTHROPIC_API_URL'],
  'https://api.anthropic.com/v1',
);
const USE_ANTHROPIC = readEnv(['USE_ANTHROPIC', 'PULSE_USE_ANTHROPIC']);

export const CoderAI = (USE_ANTHROPIC
  ? createAnthropic({
    apiKey: ANTHROPIC_API_KEY,
    baseURL: ANTHROPIC_API_URL,
  })
  : createOpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_API_URL,
  }).responses) as (model: string) => LanguageModel;

export interface BuildProviderOptions {
  headers?: Record<string, string>;
}

/**
 * Construct a LLMProviderFactory from a named ModelType using environment variables.
 * Both types use the OpenAI-compatible SDK since most proxies expose models via
 * the OpenAI-compatible endpoint (/v1/chat/completions).
 *
 * Priority: project env (e.g. `OPENAI_API_KEY`) > global `PULSE_`-prefixed env
 * (e.g. `PULSE_OPENAI_API_KEY`) > default.
 *
 * - 'openai' → OPENAI_API_KEY / OPENAI_API_URL (or PULSE_* fallback)
 * - 'claude' → ANTHROPIC_API_KEY / ANTHROPIC_API_URL (or PULSE_* fallback)
 *
 * The modelType is still meaningful for pre-processing (e.g. system message consolidation).
 */
export function buildProvider(type: ModelType, options?: BuildProviderOptions): LLMProviderFactory {
  if (type === 'claude') {
    return createAnthropic({
      apiKey: ANTHROPIC_API_KEY,
      baseURL: ANTHROPIC_API_URL,
      headers: {
        'user-agent': 'claude-code/2.1.63',
        ...(options?.headers ?? {}),
      },
    }) as LLMProviderFactory;
  }
  return createOpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_API_URL,
    headers: options?.headers,
  }).responses as LLMProviderFactory;
}

export const DEFAULT_MODEL = readEnv(
  [
    'ANTHROPIC_MODEL',
    'OPENAI_MODEL',
    'PULSE_ANTHROPIC_MODEL',
    'PULSE_OPENAI_MODEL',
  ],
  'novita/deepseek/deepseek_v3',
);

export const MAX_TURNS = 100;
export const MAX_ERROR_COUNT = 3;
export const MAX_STEPS = 100;
export const MAX_TOOL_OUTPUT_LENGTH = 30_000;

export const CONTEXT_WINDOW_TOKENS = Number(process.env.CONTEXT_WINDOW_TOKENS ?? 64_000);
export const COMPACT_TRIGGER = Number(process.env.COMPACT_TRIGGER ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.75));
export const COMPACT_TARGET = Number(process.env.COMPACT_TARGET ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.5));
export const KEEP_LAST_TURNS = Number(process.env.KEEP_LAST_TURNS ?? 4);
export const COMPACT_SUMMARY_MODEL = (process.env.COMPACT_SUMMARY_MODEL ?? '').trim();
export const COMPACT_SUMMARY_MAX_TOKENS = Number(process.env.COMPACT_SUMMARY_MAX_TOKENS ?? 1200);
export const MAX_COMPACTION_ATTEMPTS = Number(process.env.MAX_COMPACTION_ATTEMPTS ?? 2);
export const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;

// Clarification settings
export const CLARIFICATION_TIMEOUT = Number(process.env.CLARIFICATION_TIMEOUT ?? 300_000); // 5 minutes
export const CLARIFICATION_ENABLED = process.env.CLARIFICATION_ENABLED !== 'false';
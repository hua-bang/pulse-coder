import dotenv from "dotenv";
import { createOpenAI } from '@ai-sdk/openai';

dotenv.config();

console.log('OpenAI API URL:', process.env.OPENAI_API_URL, process.env.OPENAI_API_KEY);

export const CoderAI = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_API_URL || 'https://api.openai.com/v1'
});

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'novita/deepseek/deepseek_v3';

export const MAX_TURNS = 50;
import { join } from 'path';
import { homedir } from 'os';
import { createMemoryIntegrationFromEnv } from 'pulse-coder-memory-plugin';

export const memoryIntegration = createMemoryIntegrationFromEnv({
  env: process.env,
  baseDir: join(homedir(), '.pulse-coder', 'remote-memory'),
  pluginName: 'remote-memory',
  pluginVersion: '0.0.2',
});

export const memoryService = memoryIntegration.service;

export async function recordDailyLogFromSuccessPath(input: {
  platformKey: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  source: 'dispatcher' | 'internal';
}): Promise<void> {
  const userText = input.userText.trim();
  const assistantText = input.assistantText.trim();
  if (!userText && !assistantText) {
    return;
  }

  try {
    await memoryService.recordTurn({
      platformKey: input.platformKey,
      sessionId: input.sessionId,
      userText,
      assistantText,
      sourceType: 'daily-log',
    });
  } catch (error) {
    console.warn(
      `[memory-plugin] ${input.source} daily-log write failed platform=${input.platformKey} session=${input.sessionId}`,
      error,
    );
  }
}

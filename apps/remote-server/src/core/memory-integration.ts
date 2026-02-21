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

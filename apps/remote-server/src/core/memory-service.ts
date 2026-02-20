import { join } from 'path';
import { homedir } from 'os';
import { FileMemoryPluginService } from 'pulse-coder-memory-plugin';
import { resolveMemoryEmbeddingRuntimeConfigFromEnv } from './memory-embedding.js';

const embeddingRuntime = resolveMemoryEmbeddingRuntimeConfigFromEnv();

export const memoryService = new FileMemoryPluginService({
  baseDir: join(homedir(), '.pulse-coder', 'remote-memory'),
  semanticRecallEnabled: embeddingRuntime.semanticRecallEnabled,
  embeddingDimensions: embeddingRuntime.embeddingDimensions,
  embeddingProvider: embeddingRuntime.embeddingProvider,
});

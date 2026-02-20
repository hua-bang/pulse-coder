import { join } from 'path';
import { homedir } from 'os';
import { FileMemoryPluginService } from 'pulse-coder-memory-plugin';

export const memoryService = new FileMemoryPluginService({
  baseDir: join(homedir(), '.pulse-coder', 'remote-memory'),
});

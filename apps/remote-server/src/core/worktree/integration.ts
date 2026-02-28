import { homedir } from 'os';
import { join } from 'path';
import { createWorktreeIntegration } from 'pulse-coder-plugin-kit/worktree';
import { getRuntimeRepoRoot } from '../runtime-paths.js';

const DEFAULT_RUNTIME_KEY = 'remote-server';

export const worktreeIntegration = createWorktreeIntegration({
  baseDir: join(homedir(), '.pulse-coder', 'worktree-state'),
  pluginName: 'remote-worktree-binding',
  pluginVersion: '0.0.1',
  getDefaultToolBasePath: () => getRuntimeRepoRoot(),
});

export const worktreeService = worktreeIntegration.service;

export function buildRemoteWorktreeRunContext(scopeKey: string) {
  return {
    runtimeKey: resolveRemoteWorktreeRuntimeKey(),
    scopeKey,
  };
}

function resolveRemoteWorktreeRuntimeKey(): string {
  const fromEnv = process.env.PULSE_CODER_WORKTREE_RUNTIME_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_RUNTIME_KEY;
}

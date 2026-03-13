import { homedir } from 'os';
import { join } from 'path';
import { createWorkspaceIntegration } from 'pulse-coder-plugin-kit/workspace';
import { resolveWorkspaceIdentity } from './resolver.js';

const DEFAULT_RUNTIME_KEY = 'remote-server';

export const workspaceIntegration = createWorkspaceIntegration({
  baseDir: join(homedir(), '.pulse-coder', 'workspace-state'),
  pluginName: 'remote-workspace-binding',
  pluginVersion: '0.0.1',
  resolver: resolveWorkspaceIdentity,
});

export const workspaceService = workspaceIntegration.service;

export function buildRemoteWorkspaceRunContext(scopeKey: string) {
  return {
    runtimeKey: resolveRemoteWorkspaceRuntimeKey(),
    scopeKey,
  };
}

function resolveRemoteWorkspaceRuntimeKey(): string {
  const fromEnv = process.env.PULSE_CODER_WORKSPACE_RUNTIME_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_RUNTIME_KEY;
}

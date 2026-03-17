import { homedir } from 'os';
import { join } from 'path';
import { createVaultIntegration } from 'pulse-coder-plugin-kit/vault';
import { resolveVaultIdentity } from './resolver.js';

const DEFAULT_RUNTIME_KEY = 'remote-server';

export const vaultIntegration = createVaultIntegration({
  baseDir: join(homedir(), '.pulse-coder', 'workspace-state'),
  pluginName: 'remote-vault-binding',
  pluginVersion: '0.0.1',
  resolver: resolveVaultIdentity,
});

export const vaultService = vaultIntegration.service;

export function buildRemoteVaultRunContext(scopeKey: string) {
  return {
    runtimeKey: resolveRemoteVaultRuntimeKey(),
    scopeKey,
  };
}

function resolveRemoteVaultRuntimeKey(): string {
  const fromEnv = process.env.PULSE_CODER_WORKSPACE_RUNTIME_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_RUNTIME_KEY;
}

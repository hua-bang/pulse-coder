import type { VaultIdentity, VaultResolverInput } from 'pulse-coder-plugin-kit/workspace';

export function resolveVaultIdentity(input: VaultResolverInput): VaultIdentity | null {
  const engineContext = input.engineRunContext ?? {};
  const runContext = input.runContext ?? {};

  const scopeKey = readString(runContext, 'scopeKey') ?? readString(engineContext, 'platformKey');
  if (!scopeKey) {
    return null;
  }

  const runtimeKey = readString(runContext, 'runtimeKey');
  const memoryKey = readString(engineContext, 'ownerKey');
  const channelId = readString(engineContext, 'channel', 'channelId');
  const userId = readString(engineContext, 'channel', 'userId');

  return {
    key: scopeKey,
    attributes: {
      runtimeKey: runtimeKey ?? 'unknown',
      platformKey: readString(engineContext, 'platformKey') ?? 'unknown',
      memoryKey: memoryKey ?? 'unknown',
      channelId: channelId ?? 'unknown',
      userId: userId ?? 'unknown',
    },
  };
}

function readString(source: Record<string, any>, ...path: string[]): string | undefined {
  let current: any = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  if (typeof current !== 'string') {
    return undefined;
  }
  const trimmed = current.trim();
  return trimmed || undefined;
}

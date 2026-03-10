import type { ToolExecutionContext } from '../../shared/types';

function readRunContextString(runContext: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!runContext) {
    return undefined;
  }

  const value = runContext[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

export function resolveRunContextSessionId(context?: ToolExecutionContext): string {
  const runContext = context?.runContext as Record<string, unknown> | undefined;
  const sessionId = readRunContextString(runContext, 'sessionId') ?? readRunContextString(runContext, 'session_id');
  if (!sessionId) {
    throw new Error('ACP tools require runContext.sessionId.');
  }
  return sessionId;
}

export function buildAcpMetadata(
  runContext: Record<string, unknown> | undefined,
  inputMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(inputMetadata ?? {}),
  };
}

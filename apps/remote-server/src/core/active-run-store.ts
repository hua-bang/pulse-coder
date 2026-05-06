import type { ActiveRun } from './types.js';

const activeRuns = new Map<string, ActiveRun>();
// Reverse index: a "cancel token" (e.g. Discord channelId:messageId) → platformKey,
// so platform-specific signals (reactions, button clicks) can abort the run
// without having to remember the platformKey themselves.
const cancelTokenToPlatformKey = new Map<string, string>();
const platformKeyToCancelTokens = new Map<string, Set<string>>();

export function hasActiveRun(platformKey: string): boolean {
  return activeRuns.has(platformKey);
}

export function getActiveRun(platformKey: string): ActiveRun | undefined {
  return activeRuns.get(platformKey);
}

export function setActiveRun(platformKey: string, run: ActiveRun): void {
  activeRuns.set(platformKey, run);
}

export function clearActiveRun(platformKey: string): void {
  activeRuns.delete(platformKey);
  clearCancelTokens(platformKey);
}

export function clearActiveRunIfMatches(platformKey: string, streamId: string): boolean {
  const run = activeRuns.get(platformKey);
  if (!run || run.streamId !== streamId) {
    return false;
  }

  activeRuns.delete(platformKey);
  clearCancelTokens(platformKey);
  return true;
}

function clearCancelTokens(platformKey: string): void {
  const tokens = platformKeyToCancelTokens.get(platformKey);
  if (tokens) {
    for (const token of tokens) {
      cancelTokenToPlatformKey.delete(token);
    }
    platformKeyToCancelTokens.delete(platformKey);
  }
}

export function registerCancelToken(token: string, platformKey: string): void {
  if (!token || !platformKey) {
    return;
  }
  cancelTokenToPlatformKey.set(token, platformKey);
  let bucket = platformKeyToCancelTokens.get(platformKey);
  if (!bucket) {
    bucket = new Set<string>();
    platformKeyToCancelTokens.set(platformKey, bucket);
  }
  bucket.add(token);
}

export function resolvePlatformKeyByCancelToken(token: string): string | undefined {
  return cancelTokenToPlatformKey.get(token);
}

export function getActiveStreamId(platformKey: string): string | undefined {
  return activeRuns.get(platformKey)?.streamId;
}

export function abortActiveRun(platformKey: string): { aborted: boolean; startedAt?: number } {
  const run = activeRuns.get(platformKey);
  if (!run) {
    return { aborted: false };
  }

  if (!run.ac.signal.aborted) {
    run.ac.abort();
  }

  return {
    aborted: true,
    startedAt: run.startedAt,
  };
}

export function abortAndClearActiveRun(platformKey: string): { aborted: boolean; startedAt?: number } {
  const result = abortActiveRun(platformKey);
  if (result.aborted) {
    clearActiveRun(platformKey);
  }
  return result;
}

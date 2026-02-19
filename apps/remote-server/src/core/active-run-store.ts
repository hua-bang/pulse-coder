import type { ActiveRun } from './types.js';

const activeRuns = new Map<string, ActiveRun>();

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

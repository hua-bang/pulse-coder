import type { ClarificationRequest } from './types.js';

interface PendingEntry {
  request: ClarificationRequest;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * Async clarification queue using the Promise-resolver pattern.
 *
 * When the engine calls onClarificationRequest, the platform adapter:
 *   1. Sends the question to the user (e.g. Feishu message, Telegram message, SSE event)
 *   2. Calls clarificationQueue.waitForAnswer(streamId, request) — returns a Promise
 *
 * When the user replies:
 *   - Web: POST /api/clarify/:streamId → submitAnswer()
 *   - Feishu/Telegram: next incoming message → submitAnswer() in parseIncoming()
 *
 * The Promise resolves and the engine loop continues.
 */
class ClarificationQueue {
  private pending = new Map<string, PendingEntry>();

  /**
   * Park the engine loop until the user answers.
   * Called from the onClarificationRequest callback inside dispatcher.ts.
   */
  waitForAnswer(streamId: string, request: ClarificationRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(streamId);
        if (request.defaultAnswer !== undefined) {
          resolve(request.defaultAnswer);
        } else {
          reject(new Error(`Clarification timed out after ${request.timeout}ms`));
        }
      }, request.timeout);

      this.pending.set(streamId, { request, resolve, reject, timeoutHandle });
    });
  }

  /**
   * Submit the user's answer, resolving the parked Promise.
   * Returns true if there was a pending entry that matched.
   */
  submitAnswer(streamId: string, clarificationId: string, answer: string): boolean {
    const entry = this.pending.get(streamId);
    if (!entry || entry.request.id !== clarificationId) return false;

    clearTimeout(entry.timeoutHandle);
    this.pending.delete(streamId);
    entry.resolve(answer);
    return true;
  }

  /** Check if a given streamId has an unanswered clarification waiting. */
  hasPending(streamId: string): boolean {
    return this.pending.has(streamId);
  }

  /** Get the pending entry (for Feishu/Telegram to extract the clarificationId). */
  getPending(streamId: string): PendingEntry | undefined {
    return this.pending.get(streamId);
  }

  /** Cancel a pending clarification (e.g. when the run is aborted). */
  cancel(streamId: string, reason?: string): void {
    const entry = this.pending.get(streamId);
    if (!entry) return;
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(streamId);
    entry.reject(new Error(reason ?? 'Clarification cancelled'));
  }
}

export const clarificationQueue = new ClarificationQueue();

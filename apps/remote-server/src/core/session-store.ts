import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Context } from './types.js';
// ModelMessage is the Vercel AI SDK type, re-exported via pulse-coder-engine
// Context.messages is ModelMessage[] so we can use unknown[] as the storage type
// and cast when needed — avoids adding `ai` as a direct dependency

interface RemoteSession {
  id: string;
  platformKey: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[]; // Stored as-is; cast to Context['messages'] on load
}

/**
 * Lightweight session store for the remote server.
 *
 * Intentionally does NOT reuse CLI's SessionManager to avoid:
 *   - SessionMessage[] <-> ModelMessage[] conversion complexity
 *   - CJS/ESM compatibility issues (CLI is bundled as CJS)
 *
 * Storage layout:
 *   ~/.pulse-coder/remote-sessions/
 *     index.json          -> { [platformKey]: sessionId }
 *     sessions/
 *       {sessionId}.json  -> RemoteSession (with ModelMessage[])
 */
class RemoteSessionStore {
  private baseDir: string;
  private sessionsDir: string;
  private indexPath: string;
  private index: Record<string, string> = {};

  constructor() {
    this.baseDir = join(homedir(), '.pulse-coder', 'remote-sessions');
    this.sessionsDir = join(this.baseDir, 'sessions');
    this.indexPath = join(this.baseDir, 'index.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      this.index = JSON.parse(raw);
    } catch {
      this.index = {};
    }
  }

  private async saveIndex(): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * Find the current session for a platform user, or create a new one.
   * Returns a Context whose messages array is directly usable by engine.run().
   */
  async getOrCreate(platformKey: string, forceNew?: boolean): Promise<{ sessionId: string; context: Context; isNew: boolean }> {
    let sessionId = forceNew ? undefined : this.index[platformKey];

    if (sessionId) {
      try {
        const raw = await fs.readFile(this.sessionPath(sessionId), 'utf-8');
        const session: RemoteSession = JSON.parse(raw);
        return { sessionId, context: { messages: session.messages as Context['messages'] }, isNew: false };
      } catch {
        // Session file missing — create fresh
        sessionId = undefined;
      }
    }

    // Create new session
    sessionId = randomUUID();
    const session: RemoteSession = {
      id: sessionId,
      platformKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    await fs.writeFile(this.sessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8');
    this.index[platformKey] = sessionId;
    await this.saveIndex();

    return { sessionId, context: { messages: [] }, isNew: true };
  }

  /**
   * Persist the updated context back to disk after a run completes.
   */
  async save(sessionId: string, context: Context): Promise<void> {
    try {
      const raw = await fs.readFile(this.sessionPath(sessionId), 'utf-8');
      const session: RemoteSession = JSON.parse(raw);
      session.messages = context.messages as unknown[];
      session.updatedAt = Date.now();
      await fs.writeFile(this.sessionPath(sessionId), JSON.stringify(session, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[session-store] Failed to save session ${sessionId}:`, err);
    }
  }

  /**
   * Detach a platform user from their current session (for /new command).
   * The old session data is kept on disk; the user will get a fresh session next time.
   */
  async detach(platformKey: string): Promise<void> {
    delete this.index[platformKey];
    await this.saveIndex();
  }
}

export const sessionStore = new RemoteSessionStore();

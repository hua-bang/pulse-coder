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

export interface RemoteSessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export interface CurrentSessionStatus {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AttachSessionResult {
  ok: boolean;
  reason?: string;
}

export interface ClearSessionResult {
  ok: boolean;
  sessionId: string;
  createdNew: boolean;
}

export interface ForkSessionResult {
  ok: boolean;
  sessionId?: string;
  sourceSessionId?: string;
  messageCount?: number;
  reason?: string;
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

  private async readSession(sessionId: string): Promise<RemoteSession | null> {
    try {
      const raw = await fs.readFile(this.sessionPath(sessionId), 'utf-8');
      return JSON.parse(raw) as RemoteSession;
    } catch {
      return null;
    }
  }

  private async writeSession(session: RemoteSession): Promise<void> {
    await fs.writeFile(this.sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Find the current session for a platform user, or create a new one.
   * Returns a Context whose messages array is directly usable by engine.run().
   */
  async getOrCreate(platformKey: string, forceNew?: boolean): Promise<{ sessionId: string; context: Context; isNew: boolean }> {
    let sessionId = forceNew ? undefined : this.index[platformKey];

    if (sessionId) {
      const session = await this.readSession(sessionId);
      if (session) {
        return { sessionId, context: { messages: session.messages as Context['messages'] }, isNew: false };
      }
      // Session file missing — create fresh
      sessionId = undefined;
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

    await this.writeSession(session);
    this.index[platformKey] = sessionId;
    await this.saveIndex();

    return { sessionId, context: { messages: [] }, isNew: true };
  }

  /**
   * Create and attach a brand-new session for the user.
   */
  async createNewSession(platformKey: string): Promise<string> {
    const result = await this.getOrCreate(platformKey, true);
    return result.sessionId;
  }


  /**
   * Load the currently attached session context for a user.
   */
  async getCurrent(platformKey: string): Promise<{ sessionId: string; context: Context } | null> {
    const sessionId = this.index[platformKey];
    if (!sessionId) {
      return null;
    }

    const session = await this.readSession(sessionId);
    if (!session || session.platformKey !== platformKey) {
      return null;
    }

    return {
      sessionId,
      context: { messages: session.messages as Context['messages'] },
    };
  }

  /**
   * Get the currently attached session id for a user.
   */
  getCurrentSessionId(platformKey: string): string | undefined {
    return this.index[platformKey];
  }

  /**
   * Get summary of the currently attached session for a user.
   */
  async getCurrentStatus(platformKey: string): Promise<CurrentSessionStatus | null> {
    const sessionId = this.index[platformKey];
    if (!sessionId) {
      return null;
    }

    const session = await this.readSession(sessionId);
    if (!session || session.platformKey !== platformKey) {
      return null;
    }

    return {
      sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    };
  }

  /**
   * Persist the updated context back to disk after a run completes.
   */
  async save(sessionId: string, context: Context): Promise<void> {
    const session = await this.readSession(sessionId);
    if (!session) {
      console.error(`[session-store] Failed to save session ${sessionId}: session not found`);
      return;
    }

    session.messages = context.messages as unknown[];
    session.updatedAt = Date.now();

    try {
      await this.writeSession(session);
    } catch (err) {
      console.error(`[session-store] Failed to save session ${sessionId}:`, err);
    }
  }

  /**
   * Detach a platform user from their current session.
   * The old session data is kept on disk; the user will get a fresh session next time.
   */
  async detach(platformKey: string): Promise<void> {
    delete this.index[platformKey];
    await this.saveIndex();
  }

  /**
   * Attach an existing session to the user.
   * Session must belong to the same platformKey.
   */
  async attach(platformKey: string, sessionId: string): Promise<AttachSessionResult> {
    const session = await this.readSession(sessionId);
    if (!session) {
      return { ok: false, reason: `Session not found: ${sessionId}` };
    }

    if (session.platformKey !== platformKey) {
      return { ok: false, reason: 'Session does not belong to current user' };
    }

    this.index[platformKey] = sessionId;
    await this.saveIndex();
    return { ok: true };
  }

  /**
   * Clear current session context while keeping the session attached.
   * If no current session exists (or file is missing), create a fresh one.
   */
  async clearCurrent(platformKey: string): Promise<ClearSessionResult> {
    const sessionId = this.index[platformKey];

    if (!sessionId) {
      const newSessionId = await this.createNewSession(platformKey);
      return { ok: true, sessionId: newSessionId, createdNew: true };
    }

    const session = await this.readSession(sessionId);
    if (!session || session.platformKey !== platformKey) {
      const newSessionId = await this.createNewSession(platformKey);
      return { ok: true, sessionId: newSessionId, createdNew: true };
    }

    session.messages = [];
    session.updatedAt = Date.now();
    await this.writeSession(session);

    return { ok: true, sessionId, createdNew: false };
  }

  /**
   * Fork a session into a new session id and attach it as current.
   * Source session must belong to the same platformKey.
   */
  async forkSession(platformKey: string, sourceSessionId: string): Promise<ForkSessionResult> {
    const session = await this.readSession(sourceSessionId);
    if (!session) {
      return { ok: false, reason: `Session not found: ${sourceSessionId}` };
    }

    if (session.platformKey !== platformKey) {
      return { ok: false, reason: 'Session does not belong to current user' };
    }

    const now = Date.now();
    const forkedSessionId = randomUUID();
    const forkedSession: RemoteSession = {
      id: forkedSessionId,
      platformKey,
      createdAt: now,
      updatedAt: now,
      messages: this.cloneMessages(session.messages),
    };

    await this.writeSession(forkedSession);
    this.index[platformKey] = forkedSessionId;
    await this.saveIndex();

    return {
      ok: true,
      sessionId: forkedSessionId,
      sourceSessionId,
      messageCount: forkedSession.messages.length,
    };
  }

  /**
   * List sessions owned by the platform user.
   */
  async listSessions(platformKey: string, limit = 20): Promise<RemoteSessionSummary[]> {
    const files = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessions: RemoteSessionSummary[] = [];

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;

      const sessionId = file.name.replace(/\.json$/, '');
      const session = await this.readSession(sessionId);
      if (!session || session.platformKey !== platformKey) continue;

      sessions.push({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        preview: this.buildPreview(session.messages),
      });
    }

    return sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit));
  }

  private buildPreview(messages: unknown[]): string {
    if (messages.length === 0) return '(empty session)';

    const lastMessage = messages[messages.length - 1];
    if (typeof lastMessage === 'string') {
      return this.truncate(lastMessage.trim());
    }

    if (typeof lastMessage === 'object' && lastMessage !== null) {
      const content = (lastMessage as { content?: unknown }).content;
      return this.truncate(this.contentToText(content));
    }

    return this.truncate(String(lastMessage));
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part !== null && 'text' in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .filter((part) => part.length > 0);

      if (parts.length > 0) {
        return parts.join(' ').trim();
      }
    }

    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private truncate(text: string, max = 120): string {
    if (!text) return '(no text)';
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  private cloneMessages(messages: unknown[]): unknown[] {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(messages);
      } catch {
        // Fall through to JSON cloning for non-cloneable values.
      }
    }

    try {
      return JSON.parse(JSON.stringify(messages)) as unknown[];
    } catch {
      return [...messages];
    }
  }
}

export const sessionStore = new RemoteSessionStore();

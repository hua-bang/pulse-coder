/**
 * Session persistence for the Canvas Agent.
 *
 * Storage layout:
 *   ~/.pulse-coder/canvas/<workspace-id>/agent-sessions/
 *   ├── current.json          ← active session
 *   └── archive/
 *       ├── 2026-04-08.json   ← archived sessions by date
 *       └── 2026-04-07.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CanvasAgentMessage, CanvasAgentSession } from './types';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

export class SessionStore {
  private workspaceId: string;
  private sessionsDir: string;
  private currentPath: string;
  private archiveDir: string;

  private session: CanvasAgentSession | null = null;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.sessionsDir = join(STORE_DIR, workspaceId, 'agent-sessions');
    this.currentPath = join(this.sessionsDir, 'current.json');
    this.archiveDir = join(this.sessionsDir, 'archive');
  }

  /**
   * Start a new session. If a current session exists, archive it first.
   */
  async startSession(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    // Archive any existing current session
    await this.archiveCurrentIfExists();

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.session = {
      sessionId,
      workspaceId: this.workspaceId,
      startedAt: new Date().toISOString(),
      messages: [],
    };

    await this.persist();
  }

  /**
   * Add a message to the current session and persist.
   */
  addMessage(message: CanvasAgentMessage): void {
    if (!this.session) return;
    this.session.messages.push(message);
    // Fire-and-forget persist
    void this.persist();
  }

  /**
   * Get all messages from the current session.
   */
  getMessages(): CanvasAgentMessage[] {
    return this.session?.messages ?? [];
  }

  /**
   * Archive the current session and clear it.
   */
  async archiveSession(): Promise<void> {
    await this.archiveCurrentIfExists();
    this.session = null;
  }

  /**
   * List archived sessions (date + message count).
   */
  async listArchivedSessions(): Promise<Array<{ sessionId: string; date: string; messageCount: number; preview: string }>> {
    try {
      const files = await fs.readdir(this.archiveDir);
      const sessions: Array<{ sessionId: string; date: string; messageCount: number; preview: string }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(join(this.archiveDir, file), 'utf-8');
          const data = JSON.parse(raw) as CanvasAgentSession;
          const firstUserMsg = data.messages.find(m => m.role === 'user');
          sessions.push({
            sessionId: data.sessionId,
            date: data.startedAt?.slice(0, 10) || file.replace('.json', '').slice(0, 10),
            messageCount: data.messages.length,
            preview: firstUserMsg ? firstUserMsg.content.slice(0, 50) : '',
          });
        } catch {
          // skip corrupted files
        }
      }

      return sessions.sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  }

  /**
   * Read a specific archived session by date.
   */
  async readArchivedSession(date: string): Promise<CanvasAgentSession | null> {
    try {
      const raw = await fs.readFile(join(this.archiveDir, `${date}.json`), 'utf-8');
      return JSON.parse(raw) as CanvasAgentSession;
    } catch {
      return null;
    }
  }

  /**
   * Get the current session metadata (for listing alongside archived ones).
   */
  getCurrentSession(): CanvasAgentSession | null {
    return this.session;
  }

  /**
   * Load an archived session as the current session (for viewing/resuming).
   * Archives the current session first if it has messages.
   */
  async loadSession(sessionId: string): Promise<CanvasAgentSession | null> {
    // Find the archived session by sessionId
    try {
      const files = await fs.readdir(this.archiveDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await fs.readFile(join(this.archiveDir, file), 'utf-8');
        const data = JSON.parse(raw) as CanvasAgentSession;
        if (data.sessionId === sessionId) {
          // Archive current session first
          await this.archiveCurrentIfExists();
          // Set as current
          this.session = data;
          await this.persist();
          return data;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  // ─── Cross-workspace scanning ────────────────────────────────

  /**
   * Scan all workspace directories and return sessions grouped by workspace.
   * Reads current.json + archive/ for each workspace found under STORE_DIR.
   */
  static async listAllWorkspaceSessions(): Promise<
    Array<{
      workspaceId: string;
      sessions: Array<{ sessionId: string; date: string; messageCount: number; preview: string; isCurrent: boolean }>;
    }>
  > {
    const results: Array<{
      workspaceId: string;
      sessions: Array<{ sessionId: string; date: string; messageCount: number; preview: string; isCurrent: boolean }>;
    }> = [];

    let dirs: string[];
    try {
      dirs = await fs.readdir(STORE_DIR);
    } catch {
      return results;
    }

    for (const dir of dirs) {
      // Skip manifest and non-directory entries
      if (dir.startsWith('__') || dir.startsWith('.')) continue;

      const sessionsDir = join(STORE_DIR, dir, 'agent-sessions');
      const archiveDir = join(sessionsDir, 'archive');
      const currentPath = join(sessionsDir, 'current.json');

      const sessions: Array<{ sessionId: string; date: string; messageCount: number; preview: string; isCurrent: boolean }> = [];

      // Read current session
      try {
        const raw = await fs.readFile(currentPath, 'utf-8');
        const data = JSON.parse(raw) as CanvasAgentSession;
        if (data.messages && data.messages.length > 0) {
          const firstUserMsg = data.messages.find(m => m.role === 'user');
          sessions.push({
            sessionId: data.sessionId,
            date: data.startedAt?.slice(0, 10) || '',
            messageCount: data.messages.length,
            preview: firstUserMsg ? firstUserMsg.content.slice(0, 50) : '',
            isCurrent: true,
          });
        }
      } catch {
        // No current session
      }

      // Read archived sessions
      try {
        const files = await fs.readdir(archiveDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const raw = await fs.readFile(join(archiveDir, file), 'utf-8');
            const data = JSON.parse(raw) as CanvasAgentSession;
            const firstUserMsg = data.messages.find(m => m.role === 'user');
            sessions.push({
              sessionId: data.sessionId,
              date: data.startedAt?.slice(0, 10) || file.replace('.json', '').slice(0, 10),
              messageCount: data.messages.length,
              preview: firstUserMsg ? firstUserMsg.content.slice(0, 50) : '',
              isCurrent: false,
            });
          } catch {
            // skip corrupted files
          }
        }
      } catch {
        // No archive dir
      }

      if (sessions.length > 0) {
        sessions.sort((a, b) => {
          if (a.isCurrent && !b.isCurrent) return -1;
          if (!a.isCurrent && b.isCurrent) return 1;
          return b.date.localeCompare(a.date);
        });
        results.push({ workspaceId: dir, sessions });
      }
    }

    return results;
  }

  /**
   * Load a session by ID from another workspace's archive (read-only).
   */
  static async readSessionFromWorkspace(
    sourceWorkspaceId: string,
    sessionId: string,
  ): Promise<CanvasAgentSession | null> {
    const sessionsDir = join(STORE_DIR, sourceWorkspaceId, 'agent-sessions');
    const currentPath = join(sessionsDir, 'current.json');
    const archiveDir = join(sessionsDir, 'archive');

    // Check current session first
    try {
      const raw = await fs.readFile(currentPath, 'utf-8');
      const data = JSON.parse(raw) as CanvasAgentSession;
      if (data.sessionId === sessionId) return data;
    } catch {
      // ignore
    }

    // Check archive
    try {
      const files = await fs.readdir(archiveDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await fs.readFile(join(archiveDir, file), 'utf-8');
        const data = JSON.parse(raw) as CanvasAgentSession;
        if (data.sessionId === sessionId) return data;
      }
    } catch {
      // ignore
    }

    return null;
  }

  // ─── Internal ────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.session) return;
    try {
      await fs.writeFile(this.currentPath, JSON.stringify(this.session, null, 2), 'utf-8');
    } catch (err) {
      console.error('[session-store] Failed to persist session:', err);
    }
  }

  private async archiveCurrentIfExists(): Promise<void> {
    try {
      const raw = await fs.readFile(this.currentPath, 'utf-8');
      const existing = JSON.parse(raw) as CanvasAgentSession;

      if (existing.messages.length > 0) {
        // Archive with date-based filename; append timestamp to avoid collisions
        const date = existing.startedAt.slice(0, 10); // YYYY-MM-DD
        const ts = Date.now();
        const archivePath = join(this.archiveDir, `${date}-${ts}.json`);
        await fs.writeFile(archivePath, raw, 'utf-8');
      }

      // Remove current
      await fs.unlink(this.currentPath).catch(() => undefined);
    } catch {
      // No current session or corrupted — nothing to archive
    }
  }
}

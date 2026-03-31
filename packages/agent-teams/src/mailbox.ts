import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamMessage, MessageType } from './types.js';

/**
 * File-based mailbox system for inter-agent communication.
 * Each teammate has an inbox file. Messages are appended atomically.
 */
export class Mailbox {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'mailbox');
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Send a message from one teammate to another.
   */
  send(from: string, to: string, type: MessageType, content: string): TeamMessage {
    const msg: TeamMessage = {
      id: randomUUID(),
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
      read: false,
    };

    if (to === '*') {
      // Broadcast: write to all inboxes (caller should iterate team members)
      // For broadcast, we store in a shared broadcast file
      this.appendToFile('_broadcast', msg);
    } else {
      this.appendToFile(to, msg);
    }

    return msg;
  }

  /**
   * Broadcast a message to all teammates.
   * Caller provides the list of recipient IDs.
   */
  broadcast(from: string, recipientIds: string[], content: string): TeamMessage[] {
    return recipientIds
      .filter(id => id !== from)
      .map(id => this.send(from, id, 'broadcast', content));
  }

  /**
   * Read all unread messages for a teammate.
   * When `peek` is true the messages are returned but stay marked as unread,
   * so a later non-peek call (e.g. inside `Teammate.run()`) will still see them.
   */
  readUnread(recipientId: string, options?: { peek?: boolean }): TeamMessage[] {
    const peek = options?.peek ?? false;
    const messages = this.readInbox(recipientId);
    const unread = messages.filter(m => !m.read);

    // Mark as read (unless peeking)
    if (!peek && unread.length > 0) {
      const updated = messages.map(m => ({ ...m, read: true }));
      this.writeFile(recipientId, updated);
    }

    // Also check broadcasts
    const broadcasts = this.readInbox('_broadcast')
      .filter(m => m.from !== recipientId && !m.read);

    return [...unread, ...broadcasts];
  }

  /**
   * Mark specific messages as read by their IDs.
   * Useful when you peek at messages but only want to consume some of them.
   */
  markAsRead(recipientId: string, messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const idSet = new Set(messageIds);
    const messages = this.readInbox(recipientId);
    let changed = false;
    const updated = messages.map(m => {
      if (idSet.has(m.id) && !m.read) {
        changed = true;
        return { ...m, read: true };
      }
      return m;
    });
    if (changed) {
      this.writeFile(recipientId, updated);
    }
  }

  /**
   * Read all messages for a teammate (including read ones).
   */
  readAll(recipientId: string): TeamMessage[] {
    return this.readInbox(recipientId);
  }

  /**
   * Get count of unread messages for a teammate.
   */
  unreadCount(recipientId: string): number {
    const messages = this.readInbox(recipientId);
    return messages.filter(m => !m.read).length;
  }

  /**
   * Clear all messages for a teammate.
   */
  clear(recipientId: string): void {
    this.writeFile(recipientId, []);
  }

  /**
   * Clear the entire mailbox (team cleanup).
   */
  clearAll(): void {
    const { readdirSync, unlinkSync } = require('node:fs') as typeof import('node:fs');
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) {
        unlinkSync(join(this.dir, f));
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  private inboxPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private readInbox(id: string): TeamMessage[] {
    const path = this.inboxPath(id);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return [];
    }
  }

  private writeFile(id: string, messages: TeamMessage[]): void {
    writeFileSync(this.inboxPath(id), JSON.stringify(messages, null, 2), 'utf-8');
  }

  private appendToFile(id: string, msg: TeamMessage): void {
    const messages = this.readInbox(id);
    messages.push(msg);
    this.writeFile(id, messages);
  }
}

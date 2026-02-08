import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  metadata: {
    totalMessages: number;
    lastMessageAt?: number;
    tags?: string[];
  };
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export class SessionManager {
  private sessionsDir: string;

  constructor() {
    this.sessionsDir = path.join(homedir(), '.coder', 'sessions');
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  }

  async createSession(title?: string): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      title: title || `Session ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: {
        totalMessages: 0,
      },
    };

    await this.saveSession(session);
    return session;
  }

  async saveSession(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    session.metadata.totalMessages = session.messages.length;
    if (session.messages.length > 0) {
      session.metadata.lastMessageAt = session.messages[session.messages.length - 1].timestamp;
    }

    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  }

  async loadSession(id: string): Promise<Session | null> {
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  private safeContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }
    if (content === null || content === undefined) {
      return '';
    }
    return String(content);
  }

  async listSessions(limit = 20): Promise<SessionSummary[]> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const sessionFiles = files.filter(file => file.endsWith('.json'));
      
      const sessions: Session[] = [];
      for (const file of sessionFiles) {
        const data = await fs.readFile(path.join(this.sessionsDir, file), 'utf-8');
        sessions.push(JSON.parse(data));
      }

      return sessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map(session => ({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          preview: session.messages.length > 0 
            ? this.safeContent(session.messages[session.messages.length - 1].content).substring(0, 100) + '...'
            : 'No messages',
        }));
    } catch (error) {
      return [];
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`);
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  async updateSessionTitle(id: string, title: string): Promise<boolean> {
    const session = await this.loadSession(id);
    if (!session) return false;

    session.title = title;
    await this.saveSession(session);
    return true;
  }

  async addMessage(id: string, message: Omit<SessionMessage, 'timestamp'>): Promise<boolean> {
    const session = await this.loadSession(id);
    if (!session) return false;

    session.messages.push({
      ...message,
      timestamp: Date.now(),
    });

    await this.saveSession(session);
    return true;
  }

  async searchSessions(query: string): Promise<SessionSummary[]> {
    const sessions = await this.listSessions(100); // Get more for search
    const lowercaseQuery = query.toLowerCase();
    
    return sessions.filter(session =>
      session.title.toLowerCase().includes(lowercaseQuery) ||
      session.preview.toLowerCase().includes(lowercaseQuery)
    );
  }
}
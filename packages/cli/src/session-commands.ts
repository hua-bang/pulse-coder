import { SessionManager } from './session.js';
import type { Context } from '@coder/engine';

export class SessionCommands {
  private sessionManager: SessionManager;
  private currentSessionId: string | null = null;

  constructor() {
    this.sessionManager = new SessionManager();
  }

  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  async createSession(title?: string): Promise<string> {
    const session = await this.sessionManager.createSession(title);
    this.currentSessionId = session.id;
    console.log(`\n✅ New session created: ${session.title} (ID: ${session.id})`);
    return session.id;
  }

  async resumeSession(id: string): Promise<boolean> {
    const session = await this.sessionManager.loadSession(id);
    if (!session) {
      console.log(`\n❌ Session not found: ${id}`);
      return false;
    }

    this.currentSessionId = session.id;
    console.log(`\n✅ Resumed session: ${session.title} (ID: ${session.id})`);
    console.log(`📊 Loaded ${session.messages.length} messages`);

    // Show last few messages as context
    const recentMessages = session.messages.slice(-5);
    if (recentMessages.length > 0) {
      console.log('\n💬 Recent conversation:');
      recentMessages.forEach((msg, index) => {
        const role = msg.role === 'user' ? '👤 You' : '🤖 Assistant';
        const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = contentStr.substring(0, 100) + (contentStr.length > 100 ? '...' : '');
        console.log(`${index + 1}. ${role}: ${preview}`);
      });
    }

    return true;
  }

  async listSessions(): Promise<void> {
    const sessions = await this.sessionManager.listSessions();
    
    if (sessions.length === 0) {
      console.log('\n📭 No saved sessions found.');
      return;
    }

    console.log('\n📋 Saved sessions:');
    console.log('='.repeat(80));
    
    sessions.forEach((session, index) => {
      const isActive = session.id === this.currentSessionId ? '✅' : '  ';
      const date = new Date(session.updatedAt).toLocaleString();
      console.log(`${index + 1}. ${isActive} ${session.title}`);
      console.log(`   ID: ${session.id}`);
      console.log(`   Messages: ${session.messageCount} | Updated: ${date}`);
      console.log(`   Preview: ${session.preview}`);
      console.log();
    });
  }

  async saveContext(context: Context): Promise<void> {
    if (!this.currentSessionId) return;

    const session = await this.sessionManager.loadSession(this.currentSessionId);
    if (!session) return;

    // Sync messages from context
    session.messages = context.messages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      timestamp: Date.now(),
    }));

    await this.sessionManager.saveSession(session);
  }

  async loadContext(context: Context): Promise<void> {
    if (!this.currentSessionId) return;

    const session = await this.sessionManager.loadSession(this.currentSessionId);
    if (!session) return;

    // Load messages into context
    context.messages = session.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  async searchSessions(query: string): Promise<void> {
    const sessions = await this.sessionManager.searchSessions(query);
    
    if (sessions.length === 0) {
      console.log(`\n🔍 No sessions found matching "${query}"`);
      return;
    }

    console.log(`\n🔍 Search results for "${query}":`);
    sessions.forEach((session, index) => {
      console.log(`${index + 1}. ${session.title} (${session.id}) - ${session.messageCount} messages`);
      console.log(`   Updated: ${new Date(session.updatedAt).toLocaleString()}`);
      console.log(`   Preview: ${session.preview}`);
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const success = await this.sessionManager.deleteSession(id);
    if (success) {
      console.log(`\n🗑️ Session ${id} deleted`);
      if (this.currentSessionId === id) {
        this.currentSessionId = null;
      }
    } else {
      console.log(`\n❌ Failed to delete session ${id}`);
    }
    return success;
  }

  async renameSession(id: string, newTitle: string): Promise<boolean> {
    const success = await this.sessionManager.updateSessionTitle(id, newTitle);
    if (success) {
      console.log(`\n✅ Session ${id} renamed to "${newTitle}"`);
    } else {
      console.log(`\n❌ Failed to rename session ${id}`);
    }
    return success;
  }
}
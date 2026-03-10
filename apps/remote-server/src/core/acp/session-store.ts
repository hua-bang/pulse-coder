import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface AcpSessionBinding {
  remoteSessionId: string;
  acpSessionId: string;
  target: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

interface AcpSessionStorePayload {
  sessions: Record<string, AcpSessionBinding>;
}

const DEFAULT_STORE_PATH = join(homedir(), '.pulse-coder', 'acp', 'sessions.json');

export class AcpSessionStore {
  private readonly filePath: string;

  private initialized = false;

  private sessions = new Map<string, AcpSessionBinding>();

  constructor(filePath: string = DEFAULT_STORE_PATH) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AcpSessionStorePayload;
      if (parsed && parsed.sessions && typeof parsed.sessions === 'object') {
        for (const value of Object.values(parsed.sessions)) {
          if (
            value
            && typeof value.remoteSessionId === 'string'
            && typeof value.acpSessionId === 'string'
            && typeof value.target === 'string'
          ) {
            this.sessions.set(value.remoteSessionId, value);
          }
        }
      }
    } catch {
      // Ignore missing/invalid file and start with empty state.
    }

    this.initialized = true;
  }

  async get(remoteSessionId: string): Promise<AcpSessionBinding | null> {
    await this.initialize();
    return this.sessions.get(remoteSessionId) ?? null;
  }

  async upsert(binding: Omit<AcpSessionBinding, 'createdAt' | 'updatedAt'>): Promise<AcpSessionBinding> {
    await this.initialize();
    const now = Date.now();
    const existing = this.sessions.get(binding.remoteSessionId);

    const next: AcpSessionBinding = {
      ...binding,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.sessions.set(binding.remoteSessionId, next);
    await this.persist();
    return next;
  }

  async remove(remoteSessionId: string): Promise<void> {
    await this.initialize();
    if (!this.sessions.delete(remoteSessionId)) {
      return;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload: AcpSessionStorePayload = {
      sessions: Object.fromEntries(this.sessions.entries()),
    };

    await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

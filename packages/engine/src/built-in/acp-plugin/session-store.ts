import { promises as fs } from 'fs';
import path from 'path';

import type { AcpSessionBinding, AcpSessionStore } from './types';

interface AcpSessionStorePayload {
  sessions: Record<string, AcpSessionBinding | Record<string, AcpSessionBinding>>;
  latestTargets?: Record<string, string>;
}

export class FileAcpSessionStore implements AcpSessionStore {
  private readonly filePath: string;

  private initialized = false;

  private sessions = new Map<string, AcpSessionBinding>();
  private latestTargetByRemoteSession = new Map<string, string>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AcpSessionStorePayload;
      if (parsed && parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [remoteSessionId, entry] of Object.entries(parsed.sessions)) {
          if (
            entry
            && typeof (entry as AcpSessionBinding).remoteSessionId === 'string'
            && typeof (entry as AcpSessionBinding).acpSessionId === 'string'
            && typeof (entry as AcpSessionBinding).target === 'string'
          ) {
            const binding = entry as AcpSessionBinding;
            this.sessions.set(this.makeKey(binding.remoteSessionId, binding.target), binding);
            this.latestTargetByRemoteSession.set(binding.remoteSessionId, binding.target);
            continue;
          }

          if (entry && typeof entry === 'object') {
            for (const value of Object.values(entry)) {
              if (
                value
                && typeof value.remoteSessionId === 'string'
                && typeof value.acpSessionId === 'string'
                && typeof value.target === 'string'
              ) {
                this.sessions.set(this.makeKey(value.remoteSessionId, value.target), value);
                this.latestTargetByRemoteSession.set(value.remoteSessionId, value.target);
              }
            }
          }
        }
      }

      if (parsed && parsed.latestTargets && typeof parsed.latestTargets === 'object') {
        for (const [remoteSessionId, target] of Object.entries(parsed.latestTargets)) {
          if (typeof target === 'string' && target.trim()) {
            this.latestTargetByRemoteSession.set(remoteSessionId, target.trim());
          }
        }
      }
    } catch {
      // Ignore missing/invalid file and start with empty state.
    }

    this.initialized = true;
  }

  async get(remoteSessionId: string, target: string): Promise<AcpSessionBinding | null> {
    await this.initialize();
    return this.sessions.get(this.makeKey(remoteSessionId, target)) ?? null;
  }

  async getLatest(remoteSessionId: string): Promise<AcpSessionBinding | null> {
    await this.initialize();
    const target = this.latestTargetByRemoteSession.get(remoteSessionId);
    if (!target) {
      return null;
    }
    return this.sessions.get(this.makeKey(remoteSessionId, target)) ?? null;
  }

  async upsert(binding: Omit<AcpSessionBinding, 'createdAt' | 'updatedAt'>): Promise<AcpSessionBinding> {
    await this.initialize();
    const now = Date.now();
    const key = this.makeKey(binding.remoteSessionId, binding.target);
    const existing = this.sessions.get(key);

    const next: AcpSessionBinding = {
      ...binding,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.sessions.set(key, next);
    this.latestTargetByRemoteSession.set(binding.remoteSessionId, binding.target);
    await this.persist();
    return next;
  }

  async remove(remoteSessionId: string, target: string): Promise<void> {
    await this.initialize();
    const key = this.makeKey(remoteSessionId, target);
    if (!this.sessions.delete(key)) {
      return;
    }

    const latest = this.latestTargetByRemoteSession.get(remoteSessionId);
    if (latest === target) {
      this.latestTargetByRemoteSession.delete(remoteSessionId);
    }

    await this.persist();
  }

  private async persist(): Promise<void> {
    const sessionsPayload: Record<string, Record<string, AcpSessionBinding>> = {};
    for (const binding of this.sessions.values()) {
      if (!sessionsPayload[binding.remoteSessionId]) {
        sessionsPayload[binding.remoteSessionId] = {};
      }
      sessionsPayload[binding.remoteSessionId][binding.target] = binding;
    }

    const payload: AcpSessionStorePayload = {
      sessions: sessionsPayload,
      latestTargets: Object.fromEntries(this.latestTargetByRemoteSession.entries()),
    };

    await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  private makeKey(remoteSessionId: string, target: string): string {
    return `${remoteSessionId}::${target}`;
  }
}

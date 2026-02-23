import { promises as fs } from 'fs';
import { join } from 'path';
import type { MemoryItem, MemoryState } from '../types.js';

const STORAGE_FILE_VERSION = 1;

interface MemoryFileEnvelope {
  version: number;
  updatedAt: number;
  items: MemoryItem[];
}

interface UserMemoryFileEnvelope extends MemoryFileEnvelope {
  sessionEnabled?: Record<string, boolean>;
}

interface LoadedState {
  items: MemoryItem[];
  sessionEnabled: Record<string, boolean>;
}

interface LegacyStateLoadResult {
  path: string;
  state: LoadedState;
}

interface PlatformMemoryPayload {
  userItems: MemoryItem[];
  dailyByDay: Map<string, MemoryItem[]>;
  sessionEnabledBySessionId: Record<string, boolean>;
}

export interface StateLoadResult {
  state: MemoryState;
  legacyPath?: string;
}

export class LayeredMemoryStateStore {
  private readonly baseDir: string;
  private readonly legacyStatePath: string;
  private readonly legacyBackupPath: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.legacyStatePath = join(baseDir, 'state.json');
    this.legacyBackupPath = join(baseDir, 'state.v1.backup.json');
  }

  async loadMergedState(): Promise<StateLoadResult> {
    await fs.mkdir(this.baseDir, { recursive: true });

    const layeredState = await this.loadLayeredState();
    const legacyState = await this.loadLegacyState();
    const state = this.mergeLoadedStates(layeredState, legacyState?.state);

    return {
      state,
      legacyPath: legacyState?.path,
    };
  }

  async saveState(state: MemoryState): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });

    const expectedFiles = new Set<string>();
    const payloads = this.buildPlatformPayloads(state);

    for (const [platformKey, payload] of payloads.entries()) {
      const platformDir = this.platformDirPath(platformKey);
      await fs.mkdir(platformDir, { recursive: true });

      if (payload.userItems.length > 0 || Object.keys(payload.sessionEnabledBySessionId).length > 0) {
        const userPath = this.userMemoryPath(platformKey);
        await fs.mkdir(join(platformDir, 'user'), { recursive: true });
        await this.writeJsonAtomic(userPath, {
          version: STORAGE_FILE_VERSION,
          updatedAt: Date.now(),
          items: payload.userItems,
          sessionEnabled: payload.sessionEnabledBySessionId,
        } satisfies UserMemoryFileEnvelope);
        expectedFiles.add(userPath);
      }

      for (const [dayKey, items] of payload.dailyByDay.entries()) {
        const dailyPath = this.dailyMemoryPath(platformKey, dayKey);
        await fs.mkdir(join(platformDir, 'daily'), { recursive: true });
        await this.writeJsonAtomic(dailyPath, {
          version: STORAGE_FILE_VERSION,
          updatedAt: Date.now(),
          items,
        } satisfies MemoryFileEnvelope);
        expectedFiles.add(dailyPath);
      }
    }

    await this.cleanupLayeredFiles(expectedFiles);
  }

  async backupLegacyState(legacyPath: string): Promise<void> {
    const backupExists = await this.fileExists(this.legacyBackupPath);
    if (backupExists) {
      await fs.rm(legacyPath, { force: true });
      return;
    }

    await fs.rename(legacyPath, this.legacyBackupPath);
  }

  private async loadLayeredState(): Promise<LoadedState> {
    const loaded: LoadedState = { items: [], sessionEnabled: {} };
    const platformDirs = await this.listPlatformDirectories();

    for (const platformKey of platformDirs) {
      await this.loadUserLayer(platformKey, loaded);
      await this.loadDailyLayer(platformKey, loaded);
    }

    return loaded;
  }

  private async loadUserLayer(platformKey: string, loaded: LoadedState): Promise<void> {
    const userPath = this.userMemoryPath(platformKey);
    const raw = await this.readJsonFile<unknown>(userPath);
    if (!raw) {
      return;
    }

    for (const item of this.extractItems(raw)) {
      const normalized = this.normalizeLoadedItem(item, platformKey);
      if (normalized) {
        loaded.items.push(normalized);
      }
    }

    for (const [sessionId, enabled] of this.extractSessionEnabled(raw)) {
      loaded.sessionEnabled[this.sessionKey(platformKey, sessionId)] = enabled;
    }
  }

  private async loadDailyLayer(platformKey: string, loaded: LoadedState): Promise<void> {
    const dailyDir = join(this.platformDirPath(platformKey), 'daily');
    const dailyFiles = await this.listJsonFiles(dailyDir);

    for (const filePath of dailyFiles) {
      const raw = await this.readJsonFile<unknown>(filePath);
      if (!raw) {
        continue;
      }

      const defaultDayKey = this.dayKeyFromFileName(filePath);
      for (const item of this.extractItems(raw)) {
        const normalized = this.normalizeLoadedItem(item, platformKey, defaultDayKey);
        if (normalized) {
          loaded.items.push(normalized);
        }
      }
    }
  }

  private async loadLegacyState(): Promise<LegacyStateLoadResult | undefined> {
    const exists = await this.fileExists(this.legacyStatePath);
    if (!exists) {
      return undefined;
    }

    const raw = await this.readJsonFile<unknown>(this.legacyStatePath);
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const parsed = raw as Partial<MemoryState>;
    return {
      path: this.legacyStatePath,
      state: {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        sessionEnabled: parsed.sessionEnabled && typeof parsed.sessionEnabled === 'object'
          ? parsed.sessionEnabled
          : {},
      },
    };
  }

  private mergeLoadedStates(layered: LoadedState, legacy?: LoadedState): MemoryState {
    const mergedItems = new Map<string, MemoryItem>();

    const pushItem = (item: MemoryItem) => {
      if (!item || typeof item.id !== 'string' || item.id.trim() === '') {
        return;
      }
      const existing = mergedItems.get(item.id);
      if (!existing || (item.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        mergedItems.set(item.id, item);
      }
    };

    for (const item of legacy?.items ?? []) {
      pushItem(item);
    }
    for (const item of layered.items) {
      pushItem(item);
    }

    return {
      items: [...mergedItems.values()],
      sessionEnabled: {
        ...(legacy?.sessionEnabled ?? {}),
        ...layered.sessionEnabled,
      },
    };
  }

  private buildPlatformPayloads(state: MemoryState): Map<string, PlatformMemoryPayload> {
    const payloads = new Map<string, PlatformMemoryPayload>();

    const ensurePayload = (platformKey: string): PlatformMemoryPayload => {
      let payload = payloads.get(platformKey);
      if (!payload) {
        payload = {
          userItems: [],
          dailyByDay: new Map<string, MemoryItem[]>(),
          sessionEnabledBySessionId: {},
        };
        payloads.set(platformKey, payload);
      }
      return payload;
    };

    for (const item of state.items) {
      if (!item.platformKey) {
        continue;
      }

      const payload = ensurePayload(item.platformKey);
      if (item.scope === 'session') {
        const dayKey = this.resolveStorageDayKey(item);
        const bucket = payload.dailyByDay.get(dayKey) ?? [];
        bucket.push(item);
        payload.dailyByDay.set(dayKey, bucket);
        continue;
      }

      payload.userItems.push(item);
    }

    for (const [key, enabled] of Object.entries(state.sessionEnabled)) {
      if (typeof enabled !== 'boolean') {
        continue;
      }

      const parsed = this.parseSessionKey(key);
      if (!parsed) {
        continue;
      }

      const payload = ensurePayload(parsed.platformKey);
      payload.sessionEnabledBySessionId[parsed.sessionId] = enabled;
    }

    return payloads;
  }

  private async cleanupLayeredFiles(expectedFiles: Set<string>): Promise<void> {
    const platformDirs = await this.listPlatformDirectories();

    for (const platformKey of platformDirs) {
      const userPath = this.userMemoryPath(platformKey);
      if ((await this.fileExists(userPath)) && !expectedFiles.has(userPath)) {
        await fs.rm(userPath, { force: true });
      }

      const dailyDir = join(this.platformDirPath(platformKey), 'daily');
      const dailyFiles = await this.listJsonFiles(dailyDir);
      for (const dailyPath of dailyFiles) {
        if (!expectedFiles.has(dailyPath)) {
          await fs.rm(dailyPath, { force: true });
        }
      }

      await this.removeDirIfEmpty(dailyDir);
      await this.removeDirIfEmpty(join(this.platformDirPath(platformKey), 'user'));
      await this.removeDirIfEmpty(this.platformDirPath(platformKey));
    }
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(value, null, 2);
    await fs.writeFile(tmpPath, payload, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private normalizeLoadedItem(raw: unknown, platformKey: string, defaultDayKey?: string): MemoryItem | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }

    const item = raw as MemoryItem;
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      return undefined;
    }

    item.platformKey = platformKey;

    if (item.scope === 'session' && !this.normalizeDayKey(item.dayKey) && defaultDayKey) {
      item.dayKey = defaultDayKey;
    }

    return item;
  }

  private extractItems(raw: unknown): MemoryItem[] {
    if (Array.isArray(raw)) {
      return raw as MemoryItem[];
    }

    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const envelope = raw as Partial<MemoryFileEnvelope>;
    return Array.isArray(envelope.items) ? envelope.items : [];
  }

  private extractSessionEnabled(raw: unknown): Array<[string, boolean]> {
    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const envelope = raw as Partial<UserMemoryFileEnvelope>;
    if (!envelope.sessionEnabled || typeof envelope.sessionEnabled !== 'object') {
      return [];
    }

    return Object.entries(envelope.sessionEnabled)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
      .map(([key, enabled]) => {
        const parsed = this.parseSessionKey(key);
        if (parsed) {
          return [parsed.sessionId, enabled];
        }
        return [key, enabled];
      });
  }

  private async readJsonFile<T>(filePath: string): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private async listPlatformDirectories(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async listJsonFiles(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => join(dirPath, entry.name));
    } catch {
      return [];
    }
  }

  private async removeDirIfEmpty(dirPath: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath);
      if (entries.length === 0) {
        await fs.rmdir(dirPath);
      }
    } catch {
      // noop
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private resolveStorageDayKey(item: MemoryItem): string {
    const existing = this.normalizeDayKey(item.dayKey);
    if (existing) {
      return existing;
    }

    const fallbackSource = Number.isFinite(item.createdAt) ? item.createdAt : item.updatedAt;
    return this.toDayKey(Number.isFinite(fallbackSource) ? fallbackSource : Date.now());
  }

  private normalizeDayKey(dayKey?: string): string | undefined {
    if (typeof dayKey !== 'string') {
      return undefined;
    }

    const normalized = dayKey.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
  }

  private dayKeyFromFileName(filePath: string): string | undefined {
    const fileName = filePath.split('/').pop() ?? '';
    const stem = fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName;
    return this.normalizeDayKey(stem);
  }

  private toDayKey(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private platformDirPath(platformKey: string): string {
    return join(this.baseDir, platformKey);
  }

  private userMemoryPath(platformKey: string): string {
    return join(this.platformDirPath(platformKey), 'user', 'memories.json');
  }

  private dailyMemoryPath(platformKey: string, dayKey: string): string {
    return join(this.platformDirPath(platformKey), 'daily', `${dayKey}.json`);
  }

  private sessionKey(platformKey: string, sessionId: string): string {
    return `${platformKey}:${sessionId}`;
  }

  private parseSessionKey(key: string): { platformKey: string; sessionId: string } | undefined {
    const separator = key.lastIndexOf(':');
    if (separator <= 0 || separator >= key.length - 1) {
      return undefined;
    }

    return {
      platformKey: key.slice(0, separator),
      sessionId: key.slice(separator + 1),
    };
  }
}

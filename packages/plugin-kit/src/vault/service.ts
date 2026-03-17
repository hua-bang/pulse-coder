import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  FileVaultServiceOptions,
  VaultContext,
  VaultIdentity,
  VaultIndexState,
  VaultRecord,
} from './types.js';

const STATE_VERSION = 1;

export class FileVaultPluginService {
  private readonly baseDir: string;
  private readonly statePath: string;
  private readonly vaultRoot: string;

  private state: VaultIndexState = createEmptyState();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: FileVaultServiceOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'workspace-state');
    this.statePath = join(this.baseDir, 'state.json');
    this.vaultRoot = join(this.baseDir, 'workspaces');
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitialize();
    await this.initPromise;
  }

  async getVault(id: string): Promise<VaultContext | null> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return null;
    }

    return this.withLock(async () => {
      const record = this.state.vaults[normalizedId];
      if (!record) {
        return null;
      }

      return buildVaultContext(this.vaultRoot, record);
    });
  }

  async listVaults(): Promise<VaultRecord[]> {
    return this.withLock(async () => {
      return Object.values(this.state.vaults)
        .map((record) => ({ ...record }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  async ensureVault(identity: VaultIdentity): Promise<VaultContext> {
    const normalized = normalizeIdentity(identity);
    if (!normalized) {
      throw new Error('Vault identity requires a non-empty key.');
    }

    return this.withLock(async () => {
      const now = Date.now();
      const existing = this.state.vaults[normalized.id];
      const record: VaultRecord = {
        id: normalized.id,
        key: normalized.key,
        attributes: normalized.attributes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      this.state.vaults[record.id] = record;
      this.state.updatedAt = now;
      await this.persistState();

      const context = buildVaultContext(this.vaultRoot, record);
      await ensureVaultDirectories(context);
      return context;
    });
  }

  async removeVault(id: string): Promise<VaultRecord | null> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return null;
    }

    return this.withLock(async () => {
      const existing = this.state.vaults[normalizedId];
      if (!existing) {
        return null;
      }

      delete this.state.vaults[normalizedId];
      this.state.updatedAt = Date.now();
      await this.persistState();
      return { ...existing };
    });
  }

  private async runInitialize(): Promise<void> {
    await fs.mkdir(this.vaultRoot, { recursive: true });

    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      this.state = normalizeState(raw);
    } catch {
      this.state = createEmptyState();
    }

    this.initialized = true;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();

    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persistState(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    const tempPath = join(this.baseDir, `.state.${process.pid}.${Date.now()}.tmp`);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, this.statePath);
  }
}

function normalizeIdentity(identity: VaultIdentity): VaultIdentity & { id: string } | null {
  const key = identity.key?.trim();
  if (!key) {
    return null;
  }

  const attributes = normalizeAttributes(identity.attributes);
  return {
    id: key,
    key,
    attributes,
  };
}

function normalizeAttributes(input?: Record<string, string>): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }

  const entries = Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => [key.trim(), value.trim()])
    .filter(([key, value]) => key && value);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function createEmptyState(): VaultIndexState {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    vaults: {},
  };
}

function normalizeState(raw: string): VaultIndexState {
  try {
    const parsed = JSON.parse(raw) as Partial<VaultIndexState>;
    const vaults = normalizeVaults(parsed.vaults);

    return {
      version: STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      vaults,
    };
  } catch {
    return createEmptyState();
  }
}

function normalizeVaults(input: unknown): Record<string, VaultRecord> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized: Record<string, VaultRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const candidate = value as Partial<VaultRecord>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : key.trim();
    const vaultKey = typeof candidate.key === 'string' ? candidate.key.trim() : id;
    if (!id || !vaultKey) {
      continue;
    }

    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now();
    const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;
    const attributes = normalizeAttributes(candidate.attributes);

    normalized[id] = {
      id,
      key: vaultKey,
      attributes,
      createdAt,
      updatedAt,
    };
  }

  return normalized;
}

function buildVaultContext(root: string, record: VaultRecord): VaultContext {
  const vaultRoot = join(root, record.id);
  return {
    ...record,
    root: vaultRoot,
    configPath: join(vaultRoot, 'config.json'),
    statePath: join(vaultRoot, 'state.json'),
    artifactsPath: join(vaultRoot, 'artifacts'),
    logsPath: join(vaultRoot, 'logs'),
  };
}

async function ensureVaultDirectories(context: VaultContext): Promise<void> {
  await fs.mkdir(context.root, { recursive: true });
  await fs.mkdir(context.artifactsPath, { recursive: true });
  await fs.mkdir(context.logsPath, { recursive: true });
}

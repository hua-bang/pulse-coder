import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  FileWorkspaceServiceOptions,
  WorkspaceContext,
  WorkspaceIdentity,
  WorkspaceIndexState,
  WorkspaceRecord,
} from './types.js';

const STATE_VERSION = 1;

export class FileWorkspacePluginService {
  private readonly baseDir: string;
  private readonly statePath: string;
  private readonly workspaceRoot: string;

  private state: WorkspaceIndexState = createEmptyState();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: FileWorkspaceServiceOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'workspace-state');
    this.statePath = join(this.baseDir, 'state.json');
    this.workspaceRoot = join(this.baseDir, 'workspaces');
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

  async getWorkspace(id: string): Promise<WorkspaceContext | null> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return null;
    }

    return this.withLock(async () => {
      const record = this.state.workspaces[normalizedId];
      if (!record) {
        return null;
      }

      return buildWorkspaceContext(this.workspaceRoot, record);
    });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.withLock(async () => {
      return Object.values(this.state.workspaces)
        .map((record) => ({ ...record }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  async ensureWorkspace(identity: WorkspaceIdentity): Promise<WorkspaceContext> {
    const normalized = normalizeIdentity(identity);
    if (!normalized) {
      throw new Error('Workspace identity requires a non-empty key.');
    }

    return this.withLock(async () => {
      const now = Date.now();
      const existing = this.state.workspaces[normalized.id];
      const record: WorkspaceRecord = {
        id: normalized.id,
        key: normalized.key,
        attributes: normalized.attributes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      this.state.workspaces[record.id] = record;
      this.state.updatedAt = now;
      await this.persistState();

      const context = buildWorkspaceContext(this.workspaceRoot, record);
      await ensureWorkspaceDirectories(context);
      return context;
    });
  }

  async removeWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return null;
    }

    return this.withLock(async () => {
      const existing = this.state.workspaces[normalizedId];
      if (!existing) {
        return null;
      }

      delete this.state.workspaces[normalizedId];
      this.state.updatedAt = Date.now();
      await this.persistState();
      return { ...existing };
    });
  }

  private async runInitialize(): Promise<void> {
    await fs.mkdir(this.workspaceRoot, { recursive: true });

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

function normalizeIdentity(identity: WorkspaceIdentity): WorkspaceIdentity & { id: string } | null {
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

function createEmptyState(): WorkspaceIndexState {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    workspaces: {},
  };
}

function normalizeState(raw: string): WorkspaceIndexState {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceIndexState>;
    const workspaces = normalizeWorkspaces(parsed.workspaces);

    return {
      version: STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      workspaces,
    };
  } catch {
    return createEmptyState();
  }
}

function normalizeWorkspaces(input: unknown): Record<string, WorkspaceRecord> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized: Record<string, WorkspaceRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const candidate = value as Partial<WorkspaceRecord>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : key.trim();
    const workspaceKey = typeof candidate.key === 'string' ? candidate.key.trim() : id;
    if (!id || !workspaceKey) {
      continue;
    }

    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now();
    const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;
    const attributes = normalizeAttributes(candidate.attributes);

    normalized[id] = {
      id,
      key: workspaceKey,
      attributes,
      createdAt,
      updatedAt,
    };
  }

  return normalized;
}

function buildWorkspaceContext(root: string, record: WorkspaceRecord): WorkspaceContext {
  const workspaceRoot = join(root, record.id);
  return {
    ...record,
    root: workspaceRoot,
    configPath: join(workspaceRoot, 'config.json'),
    statePath: join(workspaceRoot, 'state.json'),
    artifactsPath: join(workspaceRoot, 'artifacts'),
    logsPath: join(workspaceRoot, 'logs'),
  };
}

async function ensureWorkspaceDirectories(context: WorkspaceContext): Promise<void> {
  await fs.mkdir(context.root, { recursive: true });
  await fs.mkdir(context.artifactsPath, { recursive: true });
  await fs.mkdir(context.logsPath, { recursive: true });
}

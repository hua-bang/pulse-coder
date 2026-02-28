import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  FileWorktreeServiceOptions,
  RemoveWorktreeResult,
  UpsertWorktreeInput,
  WorktreeBindingRecord,
  WorktreeBindingView,
  WorktreeRecord,
  WorktreeScope,
  WorktreeState,
} from './types.js';

const STATE_VERSION = 1;

export interface BindScopeResult {
  ok: boolean;
  binding?: WorktreeBindingView;
  reason?: string;
}

export interface ClearScopeResult {
  ok: boolean;
  cleared?: WorktreeBindingRecord;
}

export class FileWorktreePluginService {
  private readonly baseDir: string;
  private readonly statePath: string;

  private state: WorktreeState = createEmptyState();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: FileWorktreeServiceOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'worktree-state');
    this.statePath = join(this.baseDir, 'state.json');
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

  async getScopeBinding(scope: WorktreeScope): Promise<WorktreeBindingView | undefined> {
    return this.withLock(async () => {
      const key = buildBindingKey(scope);
      const binding = this.state.bindings[key];
      if (!binding) {
        return undefined;
      }

      const worktree = this.state.worktrees[binding.worktreeId];
      if (!worktree) {
        return undefined;
      }

      return {
        binding: { ...binding },
        worktree: { ...worktree },
      };
    });
  }

  async getWorktree(id: string): Promise<WorktreeRecord | undefined> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return undefined;
    }

    return this.withLock(async () => {
      const worktree = this.state.worktrees[normalizedId];
      return worktree ? { ...worktree } : undefined;
    });
  }

  async listWorktrees(): Promise<WorktreeRecord[]> {
    return this.withLock(async () => {
      return Object.values(this.state.worktrees)
        .map((worktree) => ({ ...worktree }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  async listBindings(runtimeKey?: string): Promise<WorktreeBindingRecord[]> {
    return this.withLock(async () => {
      return Object.values(this.state.bindings)
        .filter((binding) => !runtimeKey || binding.runtimeKey === runtimeKey)
        .map((binding) => ({ ...binding }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  async upsertWorktree(input: UpsertWorktreeInput): Promise<WorktreeRecord> {
    const normalized = normalizeUpsertInput(input);
    if (!normalized) {
      throw new Error('Invalid worktree input. id, repoRoot, and worktreePath are required.');
    }

    return this.withLock(async () => {
      const now = Date.now();
      const previous = this.state.worktrees[normalized.id];
      const next: WorktreeRecord = {
        id: normalized.id,
        repoRoot: normalized.repoRoot,
        worktreePath: normalized.worktreePath,
        branch: normalized.branch,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };

      this.state.worktrees[next.id] = next;
      this.state.updatedAt = now;
      await this.persistState();
      return { ...next };
    });
  }

  async bindScopeToWorktree(scope: WorktreeScope, worktreeId: string): Promise<BindScopeResult> {
    const normalizedId = worktreeId.trim();
    if (!normalizedId) {
      return {
        ok: false,
        reason: 'worktree id is required',
      };
    }

    return this.withLock(async () => {
      const worktree = this.state.worktrees[normalizedId];
      if (!worktree) {
        return {
          ok: false,
          reason: `worktree not found: ${normalizedId}`,
        };
      }

      const now = Date.now();
      const key = buildBindingKey(scope);
      const binding: WorktreeBindingRecord = {
        key,
        runtimeKey: scope.runtimeKey,
        scopeKey: scope.scopeKey,
        worktreeId: normalizedId,
        updatedAt: now,
      };

      this.state.bindings[key] = binding;
      this.state.updatedAt = now;
      await this.persistState();

      return {
        ok: true,
        binding: {
          binding: { ...binding },
          worktree: { ...worktree },
        },
      };
    });
  }

  async upsertAndBind(scope: WorktreeScope, input: UpsertWorktreeInput): Promise<WorktreeBindingView> {
    const normalized = normalizeUpsertInput(input);
    if (!normalized) {
      throw new Error('Invalid worktree input. id, repoRoot, and worktreePath are required.');
    }

    return this.withLock(async () => {
      const now = Date.now();
      const existingWorktree = this.state.worktrees[normalized.id];
      const worktree: WorktreeRecord = {
        id: normalized.id,
        repoRoot: normalized.repoRoot,
        worktreePath: normalized.worktreePath,
        branch: normalized.branch,
        createdAt: existingWorktree?.createdAt ?? now,
        updatedAt: now,
      };

      const key = buildBindingKey(scope);
      const binding: WorktreeBindingRecord = {
        key,
        runtimeKey: scope.runtimeKey,
        scopeKey: scope.scopeKey,
        worktreeId: worktree.id,
        updatedAt: now,
      };

      this.state.worktrees[worktree.id] = worktree;
      this.state.bindings[key] = binding;
      this.state.updatedAt = now;
      await this.persistState();

      return {
        binding: { ...binding },
        worktree: { ...worktree },
      };
    });
  }

  async clearScopeBinding(scope: WorktreeScope): Promise<ClearScopeResult> {
    return this.withLock(async () => {
      const key = buildBindingKey(scope);
      const existing = this.state.bindings[key];
      if (!existing) {
        return {
          ok: true,
        };
      }

      delete this.state.bindings[key];
      this.state.updatedAt = Date.now();
      await this.persistState();

      return {
        ok: true,
        cleared: { ...existing },
      };
    });
  }

  async removeWorktree(id: string): Promise<RemoveWorktreeResult> {
    const normalizedId = id.trim();
    if (!normalizedId) {
      return {
        ok: false,
        reason: 'worktree id is required',
      };
    }

    return this.withLock(async () => {
      const existing = this.state.worktrees[normalizedId];
      if (!existing) {
        return {
          ok: false,
          reason: `worktree not found: ${normalizedId}`,
        };
      }

      delete this.state.worktrees[normalizedId];
      for (const [key, binding] of Object.entries(this.state.bindings)) {
        if (binding.worktreeId === normalizedId) {
          delete this.state.bindings[key];
        }
      }

      this.state.updatedAt = Date.now();
      await this.persistState();
      return {
        ok: true,
        removed: { ...existing },
      };
    });
  }

  private async runInitialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });

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
    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, this.statePath);
  }
}

function buildBindingKey(scope: WorktreeScope): string {
  return `${scope.runtimeKey}:${scope.scopeKey}`;
}

function normalizeUpsertInput(input: UpsertWorktreeInput): UpsertWorktreeInput | null {
  const id = input.id.trim();
  const repoRoot = input.repoRoot.trim();
  const worktreePath = input.worktreePath.trim();
  const branch = input.branch?.trim();

  if (!id || !repoRoot || !worktreePath) {
    return null;
  }

  return {
    id,
    repoRoot,
    worktreePath,
    branch: branch || undefined,
  };
}

function createEmptyState(): WorktreeState {
  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    worktrees: {},
    bindings: {},
  };
}

function normalizeState(raw: string): WorktreeState {
  try {
    const parsed = JSON.parse(raw) as Partial<WorktreeState>;
    const worktrees = normalizeWorktrees(parsed.worktrees);
    const bindings = normalizeBindings(parsed.bindings);

    return {
      version: STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      worktrees,
      bindings,
    };
  } catch {
    return createEmptyState();
  }
}

function normalizeWorktrees(input: unknown): Record<string, WorktreeRecord> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized: Record<string, WorktreeRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const candidate = value as Partial<WorktreeRecord>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : key.trim();
    const repoRoot = typeof candidate.repoRoot === 'string' ? candidate.repoRoot.trim() : '';
    const worktreePath = typeof candidate.worktreePath === 'string' ? candidate.worktreePath.trim() : '';
    const branch = typeof candidate.branch === 'string' ? candidate.branch.trim() : undefined;
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now();
    const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;

    if (!id || !repoRoot || !worktreePath) {
      continue;
    }

    normalized[id] = {
      id,
      repoRoot,
      worktreePath,
      branch: branch || undefined,
      createdAt,
      updatedAt,
    };
  }

  return normalized;
}

function normalizeBindings(input: unknown): Record<string, WorktreeBindingRecord> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized: Record<string, WorktreeBindingRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const candidate = value as Partial<WorktreeBindingRecord>;
    const runtimeKey = typeof candidate.runtimeKey === 'string' ? candidate.runtimeKey.trim() : '';
    const scopeKey = typeof candidate.scopeKey === 'string' ? candidate.scopeKey.trim() : '';
    const worktreeId = typeof candidate.worktreeId === 'string' ? candidate.worktreeId.trim() : '';
    const normalizedKey = `${runtimeKey}:${scopeKey}`;

    if (!runtimeKey || !scopeKey || !worktreeId) {
      continue;
    }

    normalized[normalizedKey] = {
      key: normalizedKey,
      runtimeKey,
      scopeKey,
      worktreeId,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    };
  }

  return normalized;
}

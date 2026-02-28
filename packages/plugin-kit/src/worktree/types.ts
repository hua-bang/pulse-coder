export interface WorktreeScope {
  runtimeKey: string;
  scopeKey: string;
}

export interface WorktreeRecord {
  id: string;
  repoRoot: string;
  worktreePath: string;
  branch?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorktreeBindingRecord {
  key: string;
  runtimeKey: string;
  scopeKey: string;
  worktreeId: string;
  updatedAt: number;
}

export interface WorktreeBindingView {
  binding: WorktreeBindingRecord;
  worktree: WorktreeRecord;
}

export interface WorktreeState {
  version: 1;
  updatedAt: number;
  worktrees: Record<string, WorktreeRecord>;
  bindings: Record<string, WorktreeBindingRecord>;
}

export interface FileWorktreeServiceOptions {
  baseDir?: string;
}

export interface UpsertWorktreeInput {
  id: string;
  repoRoot: string;
  worktreePath: string;
  branch?: string;
}

export interface RemoveWorktreeResult {
  ok: boolean;
  reason?: string;
  removed?: WorktreeRecord;
}

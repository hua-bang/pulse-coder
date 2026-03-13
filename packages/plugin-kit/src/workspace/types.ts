export interface WorkspaceIdentity {
  key: string;
  attributes?: Record<string, string>;
}

export interface WorkspaceRecord {
  id: string;
  key: string;
  attributes?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceContext extends WorkspaceRecord {
  root: string;
  configPath: string;
  statePath: string;
  artifactsPath: string;
  logsPath: string;
}

export interface WorkspaceIndexState {
  version: 1;
  updatedAt: number;
  workspaces: Record<string, WorkspaceRecord>;
}

export interface FileWorkspaceServiceOptions {
  baseDir?: string;
}

export type WorkspaceRunContext = Record<string, any>;

export interface WorkspaceResolverInput {
  runContext?: WorkspaceRunContext;
  engineRunContext?: Record<string, any>;
}

export type WorkspaceResolver = (
  input: WorkspaceResolverInput,
) => WorkspaceIdentity | null | Promise<WorkspaceIdentity | null>;

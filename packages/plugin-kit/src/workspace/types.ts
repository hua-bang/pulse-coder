export interface VaultIdentity {
  key: string;
  attributes?: Record<string, string>;
}

export interface VaultRecord {
  id: string;
  key: string;
  attributes?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface VaultContext extends VaultRecord {
  root: string;
  configPath: string;
  statePath: string;
  artifactsPath: string;
  logsPath: string;
}

export interface VaultIndexState {
  version: 1;
  updatedAt: number;
  vaults: Record<string, VaultRecord>;
}

export interface FileVaultServiceOptions {
  baseDir?: string;
}

export type VaultRunContext = Record<string, any>;

export interface VaultResolverInput {
  runContext?: VaultRunContext;
  engineRunContext?: Record<string, any>;
}

export type VaultResolver = (
  input: VaultResolverInput,
) => VaultIdentity | null | Promise<VaultIdentity | null>;

import { promises as fs } from 'fs';
import path from 'path';
import z from 'zod';
import type { Tool } from 'pulse-coder-engine';
import type { WorkspaceContext } from './types.js';

const toolSchema = z.object({
  includeConfig: z.boolean().optional().describe('Include the workspace config file contents.'),
  includeListings: z.boolean().optional().describe('Include directory listings for workspace paths.'),
  includeHidden: z.boolean().optional().describe('Include dotfiles in directory listings.'),
  maxEntries: z.number().int().min(1).max(500).optional().describe('Max entries per directory listing.'),
  targets: z
    .array(z.enum(['root', 'artifacts', 'logs']))
    .optional()
    .describe('Directories to list. Defaults to root, artifacts, and logs.'),
  includeConfigRaw: z.boolean().optional().describe('Include raw config text even when JSON parses successfully.'),
});

type WorkspaceInspectInput = z.infer<typeof toolSchema>;

type ListingTarget = 'root' | 'artifacts' | 'logs';

type WorkspaceInspectResult = {
  ok: boolean;
  reason?: string;
  workspace?: WorkspaceView;
  config?: WorkspaceConfigView;
  listings?: Record<ListingTarget, DirectoryListing>;
};

type WorkspaceView = {
  id: string;
  root: string;
  configPath: string;
  statePath: string;
  artifactsPath: string;
  logsPath: string;
};

type WorkspaceConfigView = {
  path: string;
  exists: boolean;
  parsed?: unknown;
  raw?: string;
  error?: string;
};

type DirectoryListing = {
  path: string;
  ok: boolean;
  error?: string;
  truncated?: boolean;
  entries?: DirectoryEntry[];
};

type DirectoryEntry = {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
  mtime?: string;
};

const DEFAULT_MAX_ENTRIES = 200;
const ALL_TARGETS: ListingTarget[] = ['root', 'artifacts', 'logs'];

export function createWorkspaceInspectTool(input: {
  getWorkspace: () => Promise<WorkspaceContext | null>;
}): Tool<WorkspaceInspectInput, WorkspaceInspectResult> {
  return {
    name: 'workspace_inspect',
    description: 'Show current workspace config and directory listings.',
    inputSchema: toolSchema,
    defer_loading: true,
    execute: async (request) => {
      const workspace = await input.getWorkspace();

      if (!workspace) {
        return {
          ok: false,
          reason: 'No workspace is bound for this run.',
        };
      }

      const includeConfig = request.includeConfig ?? true;
      const includeListings = request.includeListings ?? true;
      const includeHidden = request.includeHidden ?? false;
      const maxEntries = request.maxEntries ?? DEFAULT_MAX_ENTRIES;
      const targets = normalizeTargets(request.targets);
      const includeConfigRaw = request.includeConfigRaw ?? false;

      const result: WorkspaceInspectResult = {
        ok: true,
        workspace: {
          id: workspace.id,
          root: workspace.root,
          configPath: workspace.configPath,
          statePath: workspace.statePath,
          artifactsPath: workspace.artifactsPath,
          logsPath: workspace.logsPath,
        },
      };

      if (includeConfig) {
        result.config = await readConfig(workspace.configPath, includeConfigRaw);
      }

      if (includeListings) {
        const listings: Record<ListingTarget, DirectoryListing> = {
          root: await listDirectory(workspace.root, { includeHidden, maxEntries }),
          artifacts: await listDirectory(workspace.artifactsPath, { includeHidden, maxEntries }),
          logs: await listDirectory(workspace.logsPath, { includeHidden, maxEntries }),
        };

        result.listings = pickListings(listings, targets);
      }

      return result;
    },
  };
}

function normalizeTargets(targets?: ListingTarget[]): ListingTarget[] {
  if (!targets || targets.length === 0) {
    return ALL_TARGETS;
  }
  const unique = new Set<ListingTarget>();
  for (const target of targets) {
    unique.add(target);
  }
  return ALL_TARGETS.filter((target) => unique.has(target));
}

function pickListings(
  listings: Record<ListingTarget, DirectoryListing>,
  targets: ListingTarget[],
): Record<ListingTarget, DirectoryListing> {
  const result = {} as Record<ListingTarget, DirectoryListing>;
  for (const target of targets) {
    result[target] = listings[target];
  }
  return result;
}

async function readConfig(pathname: string, includeRaw: boolean): Promise<WorkspaceConfigView> {
  try {
    const raw = await fs.readFile(pathname, 'utf-8');
    const output: WorkspaceConfigView = {
      path: pathname,
      exists: true,
    };

    const trimmed = raw.trim();
    if (!trimmed) {
      return output;
    }

    try {
      output.parsed = JSON.parse(raw) as unknown;
      if (includeRaw) {
        output.raw = raw;
      }
    } catch (error) {
      output.raw = raw;
      output.error = getErrorMessage(error);
    }

    return output;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      return {
        path: pathname,
        exists: false,
      };
    }

    return {
      path: pathname,
      exists: false,
      error: getErrorMessage(error),
    };
  }
}

async function listDirectory(
  dirPath: string,
  options: { includeHidden: boolean; maxEntries: number },
): Promise<DirectoryListing> {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const filtered = dirents.filter((dirent) => options.includeHidden || !dirent.name.startsWith('.'));
    filtered.sort((left, right) => left.name.localeCompare(right.name));
    const limited = filtered.slice(0, options.maxEntries);

    const entries = await Promise.all(
      limited.map(async (dirent) => {
        const fullPath = path.join(dirPath, dirent.name);
        const stat = await fs.lstat(fullPath).catch(() => null);

        return {
          name: dirent.name,
          type: dirent.isDirectory()
            ? 'dir'
            : dirent.isFile()
              ? 'file'
              : dirent.isSymbolicLink()
                ? 'symlink'
                : 'other',
          size: stat?.size,
          mtime: stat ? stat.mtime.toISOString() : undefined,
        } as DirectoryEntry;
      }),
    );

    return {
      path: dirPath,
      ok: true,
      entries,
      truncated: filtered.length > limited.length,
    };
  } catch (error) {
    return {
      path: dirPath,
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

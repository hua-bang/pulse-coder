import { Command } from 'commander';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  listWorkspaceIds,
  loadWorkspaceManifest,
  loadCanvas,
  saveCanvas,
  getWorkspaceDir,
  createWorkspace,
  deleteWorkspace,
  ensureWorkspaceDir,
} from '../core/store';
import { getNodeCapabilities } from '../core/nodes';
import { DEFAULT_NODE_DIMENSIONS } from '../core/constants';
import type { CanvasNode, CanvasSaveData } from '../core/types';
import { output, errorOutput, type OutputFormat } from '../output';

function getOpts(cmd: Command): { format: OutputFormat; storeDir?: string } {
  const root = cmd.parent?.parent ?? cmd.parent;
  const opts = root?.opts() ?? {};
  return { format: opts.format ?? 'text', storeDir: opts.storeDir };
}

export function registerWorkspaceCommands(program: Command): void {
  const ws = program
    .command('workspace')
    .description('Manage canvas workspaces');

  ws.command('list')
    .description('List all workspaces')
    .action(async function (this: Command) {
      const { format, storeDir } = getOpts(this);
      const ids = await listWorkspaceIds(storeDir);
      const manifest = await loadWorkspaceManifest(storeDir);
      const nameMap = new Map((manifest.workspaces ?? []).map(e => [e.id, e.name]));

      const rows = ids.map(id => ({
        id,
        name: nameMap.get(id) ?? id,
      }));

      output(rows, format, (data) => {
        const items = data as typeof rows;
        if (items.length === 0) return 'No workspaces found.';
        const lines = items.map(r => `  ${r.id}  ${r.name}`);
        return `Workspaces:\n${lines.join('\n')}`;
      });
    });

  ws.command('info')
    .argument('<workspaceId>', 'Workspace ID')
    .description('Show workspace details')
    .action(async function (this: Command, workspaceId: string) {
      const { format, storeDir } = getOpts(this);
      const canvas = await loadCanvas(workspaceId, storeDir);
      if (!canvas) errorOutput(`Workspace not found: ${workspaceId}`);

      const manifest = await loadWorkspaceManifest(storeDir);
      const entry = (manifest.workspaces ?? []).find(e => e.id === workspaceId);

      const typeCounts: Record<string, number> = {};
      for (const node of canvas!.nodes) {
        typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
      }

      const info = {
        id: workspaceId,
        name: entry?.name ?? workspaceId,
        path: getWorkspaceDir(workspaceId, storeDir),
        nodeCount: canvas!.nodes.length,
        nodeTypes: typeCounts,
        savedAt: canvas!.savedAt,
      };

      output(info, format, (data) => {
        const d = data as typeof info;
        const types = Object.entries(d.nodeTypes).map(([t, c]) => `${t}: ${c}`).join(', ');
        return [
          `Workspace: ${d.name} (${d.id})`,
          `Path: ${d.path}`,
          `Nodes: ${d.nodeCount} (${types || 'none'})`,
          `Last saved: ${d.savedAt}`,
        ].join('\n');
      });
    });

  ws.command('create')
    .argument('<name>', 'Workspace name')
    .description('Create a new workspace')
    .action(async function (this: Command, name: string) {
      const { format, storeDir } = getOpts(this);
      const result = await createWorkspace(name, storeDir);
      if (!result.ok) errorOutput(result.error);

      output(result.data, format, (data) => {
        const d = data as { id: string };
        return `Created workspace: ${d.id}`;
      });
    });

  ws.command('delete')
    .argument('<workspaceId>', 'Workspace ID')
    .option('--confirm', 'Skip confirmation')
    .description('Delete a workspace')
    .action(async function (this: Command, workspaceId: string, cmdOpts: { confirm?: boolean }) {
      const { format, storeDir } = getOpts(this);
      if (!cmdOpts.confirm) {
        errorOutput('Use --confirm to delete a workspace. This action is irreversible.');
      }

      const result = await deleteWorkspace(workspaceId, storeDir);
      if (!result.ok) errorOutput(result.error);

      output({ deleted: workspaceId }, format, () => `Deleted workspace: ${workspaceId}`);
    });

  ws.command('recover')
    .argument('<workspaceId>', 'Workspace ID')
    .option('--dry-run', 'Show what would be restored without writing canvas.json')
    .description('Rebuild file nodes in canvas.json from markdown files in the notes/ directory')
    .action(async function (
      this: Command,
      workspaceId: string,
      cmdOpts: { dryRun?: boolean },
    ) {
      const { format, storeDir } = getOpts(this);
      await ensureWorkspaceDir(workspaceId, storeDir);

      const canvas: CanvasSaveData = (await loadCanvas(workspaceId, storeDir)) ?? {
        nodes: [],
        transform: { x: 0, y: 0, scale: 1 },
        savedAt: new Date().toISOString(),
      };

      const notesDir = join(getWorkspaceDir(workspaceId, storeDir), 'notes');
      let noteFiles: string[] = [];
      try {
        const entries = await fs.readdir(notesDir, { withFileTypes: true });
        noteFiles = entries
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => e.name);
      } catch {
        errorOutput(`Notes directory not found: ${notesDir}`);
      }

      // Note files are written as `{safeTitle}-{nodeId}.md` where nodeId
      // matches `node-<ts>-<rand>`. Parse that back so we reuse the
      // original id when possible (keeps references stable).
      const NODE_ID_RE = /^(.+)-(node-\d+-[a-z0-9]+)\.md$/;

      // Build a set of file paths already referenced by existing nodes
      // so we don't double-add them.
      const existingPaths = new Set<string>();
      for (const n of canvas.nodes) {
        if (n.type === 'file' && n.data?.filePath) {
          existingPaths.add(n.data.filePath);
        }
      }

      const def = DEFAULT_NODE_DIMENSIONS.file;
      const GAP = 40;
      const COLS = 4;
      // Layout newly created nodes in a grid starting below the lowest
      // existing node (or at 100,100 if the canvas is empty).
      let baseY = 100;
      if (canvas.nodes.length > 0) {
        baseY = Math.max(...canvas.nodes.map((n) => n.y + n.height)) + GAP;
      }

      const restored: Array<{ nodeId: string; title: string; filePath: string }> = [];
      const skipped: string[] = [];
      let idx = 0;

      for (const fileName of noteFiles.sort()) {
        const filePath = join(notesDir, fileName);
        if (existingPaths.has(filePath)) {
          skipped.push(fileName);
          continue;
        }

        let nodeId: string;
        let title: string;
        const match = fileName.match(NODE_ID_RE);
        if (match) {
          title = match[1].replace(/_/g, ' ');
          nodeId = match[2];
        } else {
          title = fileName.replace(/\.md$/, '').replace(/_/g, ' ');
          nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        // Guard against id collisions with any node already in canvas.json.
        if (canvas.nodes.some((n) => n.id === nodeId)) {
          nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        let content = '';
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          // keep empty content; filePath still points to the on-disk file
        }

        const col = idx % COLS;
        const row = Math.floor(idx / COLS);
        const x = 100 + col * (def.width + GAP);
        const y = baseY + row * (def.height + GAP);
        idx++;

        const node: CanvasNode = {
          id: nodeId,
          type: 'file',
          title: title || def.title,
          x,
          y,
          width: def.width,
          height: def.height,
          data: {
            filePath,
            content,
            saved: true,
            modified: false,
          },
          updatedAt: Date.now(),
        };

        canvas.nodes.push(node);
        restored.push({ nodeId, title: node.title, filePath });
      }

      const summary = {
        workspaceId,
        notesDir,
        notesFound: noteFiles.length,
        restored: restored.length,
        skipped: skipped.length,
        restoredNodes: restored,
        dryRun: !!cmdOpts.dryRun,
      };

      if (!cmdOpts.dryRun && restored.length > 0) {
        canvas.savedAt = new Date().toISOString();
        await saveCanvas(workspaceId, canvas, storeDir);
      }

      output(summary, format, (data) => {
        const d = data as typeof summary;
        const lines = [
          `Workspace: ${d.workspaceId}`,
          `Notes dir: ${d.notesDir}`,
          `Notes found: ${d.notesFound}`,
          `Restored:    ${d.restored}${d.dryRun ? ' (dry run — nothing written)' : ''}`,
          `Skipped:     ${d.skipped} (already present in canvas.json)`,
        ];
        if (d.restoredNodes.length > 0) {
          lines.push('', 'Restored nodes:');
          for (const n of d.restoredNodes) {
            lines.push(`  ${n.nodeId}  ${n.title}`);
          }
        }
        return lines.join('\n');
      });
    });
}

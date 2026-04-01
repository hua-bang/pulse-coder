import { Command } from 'commander';
import {
  listWorkspaceIds,
  loadWorkspaceManifest,
  loadCanvas,
  getWorkspaceDir,
  createWorkspace,
  deleteWorkspace,
} from '../core/store';
import { getNodeCapabilities } from '../core/nodes';
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
      const nameMap = new Map((manifest.entries ?? []).map(e => [e.id, e.name]));

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
      const entry = (manifest.entries ?? []).find(e => e.id === workspaceId);

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
}

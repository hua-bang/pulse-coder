import { promises as fs } from 'fs';
import { Command } from 'commander';
import { loadCanvas } from '../core/store';
import {
  getNodeCapabilities,
  readNode,
  writeNode,
  createNode,
  deleteNode,
} from '../core/nodes';
import { output, errorOutput, type OutputFormat } from '../output';
import type { NodeType } from '../core/types';

function getOpts(cmd: Command): { format: OutputFormat; storeDir?: string; workspace: string } {
  const root = cmd.parent?.parent ?? cmd.parent;
  const opts = root?.opts() ?? {};
  const workspace = opts.workspace as string | undefined;
  if (!workspace) {
    errorOutput('Workspace ID required. Use --workspace <id> or set $PULSE_CANVAS_WORKSPACE_ID');
  }
  return { format: opts.format ?? 'text', storeDir: opts.storeDir, workspace };
}

export function registerNodeCommands(program: Command): void {
  const node = program
    .command('node')
    .description('Manage canvas nodes');

  node.command('list')
    .description('List all nodes in the workspace')
    .action(async function (this: Command) {
      const { format, storeDir, workspace } = getOpts(this);
      const canvas = await loadCanvas(workspace, storeDir);
      if (!canvas) errorOutput(`Workspace not found: ${workspace}`);

      const rows = canvas!.nodes.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        capabilities: getNodeCapabilities(n.type),
      }));

      output(rows, format, (data) => {
        const items = data as typeof rows;
        if (items.length === 0) return 'No nodes found.';
        const lines = items.map(r =>
          `  ${r.id}  [${r.type}]  ${r.title}  (${r.capabilities.join(', ')})`
        );
        return `Nodes:\n${lines.join('\n')}`;
      });
    });

  node.command('read')
    .argument('<nodeId>', 'Node ID')
    .description('Read a canvas node')
    .action(async function (this: Command, nodeId: string) {
      const { format, storeDir, workspace } = getOpts(this);
      const canvas = await loadCanvas(workspace, storeDir);
      if (!canvas) errorOutput(`Workspace not found: ${workspace}`);

      const canvasNode = canvas!.nodes.find(n => n.id === nodeId);
      if (!canvasNode) errorOutput(`Node not found: ${nodeId}`);

      const result = await readNode(canvasNode!);

      output(result, format, (data) => {
        const d = data as Record<string, unknown>;
        if (d.type === 'file') {
          return String(d.content ?? '');
        }
        if (d.type === 'terminal') {
          return `Terminal (cwd: ${d.cwd ?? 'unknown'})\n${d.scrollback ?? ''}`;
        }
        if (d.type === 'frame') {
          return `Frame: ${d.label || '(no label)'}  color: ${d.color ?? ''}`;
        }
        return JSON.stringify(d, null, 2);
      });
    });

  node.command('write')
    .argument('<nodeId>', 'Node ID')
    .option('--content <text>', 'Content to write')
    .option('--file <path>', 'Read content from file')
    .description('Write content to a canvas node')
    .action(async function (this: Command, nodeId: string, cmdOpts: { content?: string; file?: string }) {
      const { format, storeDir, workspace } = getOpts(this);

      let content: string;
      if (cmdOpts.content !== undefined) {
        content = cmdOpts.content;
      } else if (cmdOpts.file) {
        try {
          content = await fs.readFile(cmdOpts.file, 'utf-8');
        } catch (err) {
          errorOutput(`Cannot read file: ${cmdOpts.file} — ${String(err)}`);
        }
      } else if (!process.stdin.isTTY) {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        content = Buffer.concat(chunks).toString('utf-8');
      } else {
        errorOutput('Provide content via --content, --file, or stdin');
      }

      const result = await writeNode(workspace, nodeId, content!, storeDir);
      if (!result.ok) errorOutput(result.error);

      output({ ok: true }, format, () => 'OK');
    });

  node.command('create')
    .requiredOption('--type <type>', 'Node type: file, terminal, frame')
    .option('--title <title>', 'Node title')
    .option('--data <json>', 'Initial data as JSON')
    .description('Create a new canvas node')
    .action(async function (this: Command, cmdOpts: { type: string; title?: string; data?: string }) {
      const { format, storeDir, workspace } = getOpts(this);

      const validTypes: NodeType[] = ['file', 'terminal', 'frame'];
      if (!validTypes.includes(cmdOpts.type as NodeType)) {
        errorOutput(`Invalid type "${cmdOpts.type}". Must be: ${validTypes.join(', ')}`);
      }

      let data: Record<string, unknown> | undefined;
      if (cmdOpts.data) {
        try {
          data = JSON.parse(cmdOpts.data) as Record<string, unknown>;
        } catch {
          errorOutput('--data must be valid JSON');
        }
      }

      const result = await createNode(workspace, {
        type: cmdOpts.type as NodeType,
        title: cmdOpts.title,
        data,
      }, storeDir);

      if (!result.ok) errorOutput(result.error);

      if (cmdOpts.type === 'terminal') {
        console.error('Note: Terminal nodes created via CLI have no active PTY session.');
      }

      output(result.data, format, (d) => {
        const r = d as { nodeId: string; type: string; title: string };
        return `Created ${r.type} node: ${r.nodeId} (${r.title})`;
      });
    });

  node.command('delete')
    .argument('<nodeId>', 'Node ID')
    .description('Delete a canvas node')
    .action(async function (this: Command, nodeId: string) {
      const { format, storeDir, workspace } = getOpts(this);

      const result = await deleteNode(workspace, nodeId, storeDir);
      if (!result.ok) errorOutput(result.error);

      output({ deleted: nodeId }, format, () => `Deleted node: ${nodeId}`);
    });
}

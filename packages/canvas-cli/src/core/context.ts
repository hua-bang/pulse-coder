import { loadCanvas, loadWorkspaceManifest, getWorkspaceDir } from './store';
import { getNodeCapabilities, readNode } from './nodes';
import type { CanvasNode, NodeReadResult } from './types';

interface ContextNode {
  id: string;
  type: string;
  title: string;
  capabilities: string[];
  [key: string]: unknown;
}

interface CanvasContext {
  workspaceId: string;
  workspaceName: string;
  canvasDir: string;
  nodes: ContextNode[];
}

function extractDescription(content: string): string {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) return heading[1];
    if (/^[-*_]{3,}$/.test(line)) continue;
    return line.replace(/[*_`#>]/g, '').trim().slice(0, 80);
  }
  return '';
}

export async function generateContext(
  workspaceId: string,
  storeDir?: string,
): Promise<CanvasContext | null> {
  const canvas = await loadCanvas(workspaceId, storeDir);
  if (!canvas) return null;

  const manifest = await loadWorkspaceManifest(storeDir);
  const entry = (manifest.entries ?? []).find(e => e.id === workspaceId);
  const workspaceName = entry?.name ?? workspaceId;
  const canvasDir = getWorkspaceDir(workspaceId, storeDir);

  const nodes: ContextNode[] = [];

  for (const node of canvas.nodes) {
    const readResult = await readNode(node);
    const base: ContextNode = {
      id: node.id,
      type: node.type,
      title: node.title,
      capabilities: getNodeCapabilities(node.type),
    };

    switch (node.type) {
      case 'file': {
        const content = (readResult as NodeReadResult & { content?: string }).content ?? '';
        base.path = (readResult as NodeReadResult & { path?: string }).path ?? '';
        base.language = (readResult as NodeReadResult & { language?: string }).language ?? '';
        base.description = extractDescription(content);
        break;
      }
      case 'terminal':
        base.cwd = (readResult as NodeReadResult & { cwd?: string }).cwd ?? '';
        break;
      case 'frame':
        base.label = (readResult as NodeReadResult & { label?: string }).label ?? '';
        base.color = (readResult as NodeReadResult & { color?: string }).color ?? '';
        break;
    }

    nodes.push(base);
  }

  return { workspaceId, workspaceName, canvasDir, nodes };
}

export function formatContextAsText(ctx: CanvasContext): string {
  const lines: string[] = [
    '# Pulse Canvas Context',
    '',
    `Workspace: ${ctx.workspaceName} (${ctx.workspaceId})`,
    `Canvas dir: ${ctx.canvasDir}`,
  ];

  const fileNodes = ctx.nodes.filter(n => n.type === 'file');
  const terminalNodes = ctx.nodes.filter(n => n.type === 'terminal');
  const frameNodes = ctx.nodes.filter(n => n.type === 'frame');

  if (fileNodes.length > 0) {
    lines.push('', '## Files', '');
    for (const node of fileNodes) {
      const pathHint = node.path ? `\`${node.path}\`` : '(unsaved)';
      const desc = node.description ? ` — ${node.description}` : '';
      lines.push(`- **${node.title}** ${pathHint}${desc}`);
    }
  }

  if (frameNodes.length > 0) {
    lines.push('', '## Frames', '');
    for (const node of frameNodes) {
      const label = node.label ? ` — ${node.label}` : '';
      lines.push(`- **${node.title}**${label}`);
    }
  }

  if (terminalNodes.length > 0) {
    lines.push('', '## Terminals', '');
    for (const node of terminalNodes) {
      const cwd = node.cwd ? ` (cwd: \`${node.cwd}\`)` : '';
      lines.push(`- **${node.title}**${cwd}`);
    }
  }

  lines.push('', '> Use file paths above to read content as needed.', '');
  return lines.join('\n');
}

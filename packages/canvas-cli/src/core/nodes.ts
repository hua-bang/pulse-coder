import { promises as fs } from 'fs';
import { join } from 'path';
import { NODE_CAPABILITIES, DEFAULT_NODE_DIMENSIONS } from './constants';
import { loadCanvas, saveCanvas, getWorkspaceDir } from './store';
import type {
  NodeType,
  NodeCapability,
  CanvasNode,
  NodeReadResult,
  Result,
} from './types';

export function getNodeCapabilities(type: NodeType): NodeCapability[] {
  return NODE_CAPABILITIES[type] ?? ['read'];
}

export async function readNode(node: CanvasNode): Promise<NodeReadResult> {
  const capabilities = getNodeCapabilities(node.type);

  switch (node.type) {
    case 'file': {
      let content = node.data.content ?? '';
      if (node.data.filePath) {
        try {
          content = await fs.readFile(node.data.filePath, 'utf-8');
        } catch {
          // fall through to in-memory content
        }
      }
      const ext = node.data.filePath?.split('.').pop() ?? '';
      return { type: 'file', capabilities, path: node.data.filePath ?? '', content, language: ext };
    }
    case 'terminal':
      return {
        type: 'terminal',
        capabilities,
        cwd: node.data.cwd ?? '',
        scrollback: node.data.scrollback ?? '',
      };
    case 'frame':
      return {
        type: 'frame',
        capabilities,
        label: node.data.label ?? '',
        color: node.data.color ?? '',
      };
    default:
      return { type: node.type, capabilities };
  }
}

export async function writeNode(
  workspaceId: string,
  nodeId: string,
  content: string,
  storeDir?: string,
): Promise<Result> {
  const canvas = await loadCanvas(workspaceId, storeDir);
  if (!canvas) return { ok: false, error: `Workspace not found: ${workspaceId}` };

  const node = canvas.nodes.find(n => n.id === nodeId);
  if (!node) return { ok: false, error: `Node not found: ${nodeId}` };

  switch (node.type) {
    case 'file': {
      if (node.data.filePath) {
        await fs.writeFile(node.data.filePath, content, 'utf-8');
      }
      node.data.content = content;
      canvas.savedAt = new Date().toISOString();
      await saveCanvas(workspaceId, canvas, storeDir);
      return { ok: true, data: undefined };
    }
    case 'frame': {
      try {
        const patch = JSON.parse(content) as { label?: string; color?: string };
        if (patch.label !== undefined) node.data.label = patch.label;
        if (patch.color !== undefined) node.data.color = patch.color;
        canvas.savedAt = new Date().toISOString();
        await saveCanvas(workspaceId, canvas, storeDir);
        return { ok: true, data: undefined };
      } catch {
        return { ok: false, error: 'Frame write expects JSON: { label?: string, color?: string }' };
      }
    }
    case 'terminal':
      return { ok: false, error: 'Terminal nodes do not support write. Use canvas_exec to send commands.' };
    default:
      return { ok: false, error: 'Unknown node type' };
  }
}

function autoPlaceX(nodes: Array<{ x?: number; width?: number }>): number {
  if (nodes.length === 0) return 100;
  let maxRight = 0;
  for (const n of nodes) {
    const right = (n.x ?? 0) + (n.width ?? 400);
    if (right > maxRight) maxRight = right;
  }
  return maxRight + 40;
}

export interface CreateNodeOptions {
  type: NodeType;
  title?: string;
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
}

export async function createNode(
  workspaceId: string,
  opts: CreateNodeOptions,
  storeDir?: string,
): Promise<Result<{ nodeId: string; type: NodeType; title: string; capabilities: NodeCapability[] }>> {
  const canvas = await loadCanvas(workspaceId, storeDir);
  if (!canvas) return { ok: false, error: `Workspace not found: ${workspaceId}` };

  const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const def = DEFAULT_NODE_DIMENSIONS[opts.type];
  if (!def) return { ok: false, error: `Unsupported node type: ${opts.type}` };

  const x = opts.x ?? autoPlaceX(canvas.nodes as Array<{ x?: number; width?: number }>);
  const y = opts.y ?? 100;

  const inputData = opts.data ?? {};
  let nodeData: Record<string, unknown>;
  switch (opts.type) {
    case 'file':
      nodeData = { filePath: '', content: (inputData as Record<string, string>).content ?? '', saved: false, modified: false };
      break;
    case 'terminal':
      nodeData = { sessionId: '', cwd: (inputData as Record<string, string>).cwd ?? '' };
      break;
    case 'frame':
      nodeData = { color: (inputData as Record<string, string>).color ?? '#9065b0', label: (inputData as Record<string, string>).label ?? '' };
      break;
  }

  const newNode: CanvasNode = {
    id: nodeId,
    type: opts.type,
    title: opts.title ?? def.title,
    x,
    y,
    width: def.width,
    height: def.height,
    data: nodeData,
  };

  canvas.nodes.push(newNode);
  canvas.savedAt = new Date().toISOString();
  await saveCanvas(workspaceId, canvas, storeDir);

  // If file node with content, create a workspace note file
  if (opts.type === 'file' && nodeData.content) {
    const notesDir = join(getWorkspaceDir(workspaceId, storeDir), 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    const noteFile = join(notesDir, `${nodeId}.md`);
    await fs.writeFile(noteFile, String(nodeData.content), 'utf-8');
    newNode.data.filePath = noteFile;
    canvas.savedAt = new Date().toISOString();
    await saveCanvas(workspaceId, canvas, storeDir);
  }

  return {
    ok: true,
    data: {
      nodeId,
      type: opts.type,
      title: newNode.title,
      capabilities: getNodeCapabilities(opts.type),
    },
  };
}

export async function deleteNode(
  workspaceId: string,
  nodeId: string,
  storeDir?: string,
): Promise<Result> {
  const canvas = await loadCanvas(workspaceId, storeDir);
  if (!canvas) return { ok: false, error: `Workspace not found: ${workspaceId}` };

  const idx = canvas.nodes.findIndex(n => n.id === nodeId);
  if (idx === -1) return { ok: false, error: `Node not found: ${nodeId}` };

  canvas.nodes.splice(idx, 1);
  canvas.savedAt = new Date().toISOString();
  await saveCanvas(workspaceId, canvas, storeDir);

  return { ok: true, data: undefined };
}

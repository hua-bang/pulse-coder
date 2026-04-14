import { promises as fs } from 'fs';
import { join } from 'path';
import { NODE_CAPABILITIES, DEFAULT_NODE_DIMENSIONS } from './constants';
import { loadCanvas, saveCanvas, ensureWorkspaceDir, getWorkspaceDir, commitNodeMutation } from './store';
import { notifyCanvasUpdated } from './notifier';
import type {
  NodeType,
  NodeCapability,
  CanvasNode,
  CanvasSaveData,
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
    case 'agent':
      return {
        type: 'agent',
        capabilities,
        cwd: node.data.cwd ?? '',
        scrollback: node.data.scrollback ?? '',
        agentType: node.data.agentType ?? 'claude-code',
        status: node.data.status ?? 'idle',
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
      node.updatedAt = Date.now();
      // Re-read canvas.json just before writing so concurrent changes
      // from the Electron renderer (or other canvas-cli invocations) to
      // other nodes are preserved. Only our target node is replaced.
      await commitNodeMutation(workspaceId, { upsert: node }, storeDir);
      await notifyCanvasUpdated({ workspaceId, nodeIds: [nodeId], kind: 'update' });
      return { ok: true, data: undefined };
    }
    case 'frame': {
      try {
        const patch = JSON.parse(content) as { label?: string; color?: string };
        if (patch.label !== undefined) node.data.label = patch.label;
        if (patch.color !== undefined) node.data.color = patch.color;
        node.updatedAt = Date.now();
        await commitNodeMutation(workspaceId, { upsert: node }, storeDir);
        await notifyCanvasUpdated({ workspaceId, nodeIds: [nodeId], kind: 'update' });
        return { ok: true, data: undefined };
      } catch {
        return { ok: false, error: 'Frame write expects JSON: { label?: string, color?: string }' };
      }
    }
    case 'terminal':
      return { ok: false, error: 'Terminal nodes do not support write. Use canvas_exec to send commands.' };
    case 'agent':
      return { ok: false, error: 'Agent nodes do not support write. Use canvas_exec to send commands.' };
    default:
      return { ok: false, error: 'Unknown node type' };
  }
}

function autoPlace(nodes: Array<{ x?: number; y?: number; width?: number; height?: number }>): { x: number; y: number } {
  if (nodes.length === 0) return { x: 100, y: 100 };
  let maxRight = 0;
  let bestY = 100;
  for (const n of nodes) {
    const right = (n.x ?? 0) + (n.width ?? 400);
    if (right > maxRight) {
      maxRight = right;
      bestY = n.y ?? 100;
    }
  }
  return { x: maxRight + 40, y: bestY };
}

export interface CreateNodeOptions {
  type: NodeType;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  data?: Record<string, unknown>;
}

export async function createNode(
  workspaceId: string,
  opts: CreateNodeOptions,
  storeDir?: string,
): Promise<Result<{ nodeId: string; type: NodeType; title: string; capabilities: NodeCapability[] }>> {
  // Auto-create canvas if it doesn't exist yet
  let canvas = await loadCanvas(workspaceId, storeDir);
  if (!canvas) {
    await ensureWorkspaceDir(workspaceId, storeDir);
    canvas = {
      nodes: [],
      transform: { x: 0, y: 0, scale: 1 },
      savedAt: new Date().toISOString(),
    } satisfies CanvasSaveData;
    // Bootstrap an empty canvas for a brand-new workspace. `loadCanvas`
    // just returned null, so nothing is at risk; opt in to the wipe guard
    // for intent-clarity.
    await saveCanvas(workspaceId, canvas, storeDir, { allowEmpty: true });
  }

  const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const def = DEFAULT_NODE_DIMENSIONS[opts.type];
  if (!def) return { ok: false, error: `Unsupported node type: ${opts.type}` };

  const auto = autoPlace(canvas.nodes);
  const x = opts.x ?? auto.x;
  const y = opts.y ?? auto.y;

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
      nodeData = { color: (inputData as Record<string, string>).color ?? '#9575d4', label: (inputData as Record<string, string>).label ?? '' };
      break;
    case 'agent':
      nodeData = { sessionId: '', cwd: (inputData as Record<string, string>).cwd ?? '', agentType: (inputData as Record<string, string>).agentType ?? 'claude-code', status: 'idle' };
      break;
  }

  // For file nodes, always create a notes file so the node has a valid filePath
  if (opts.type === 'file') {
    const notesDir = join(getWorkspaceDir(workspaceId, storeDir), 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    const title = opts.title ?? def.title;
    const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_');
    const noteFile = join(notesDir, `${safeTitle}-${nodeId}.md`);
    await fs.writeFile(noteFile, String(nodeData.content ?? ''), 'utf-8');
    nodeData.filePath = noteFile;
    nodeData.saved = true;
    nodeData.modified = false;
  }

  const newNode: CanvasNode = {
    id: nodeId,
    type: opts.type,
    title: opts.title ?? def.title,
    x,
    y,
    width: opts.width ?? def.width,
    height: opts.height ?? def.height,
    data: nodeData,
    updatedAt: Date.now(),
  };

  // Re-read canvas.json and append our new node so any nodes added by
  // the renderer (or another CLI call) between our initial loadCanvas and
  // this write are preserved.
  await commitNodeMutation(workspaceId, { upsert: newNode }, storeDir);
  await notifyCanvasUpdated({ workspaceId, nodeIds: [nodeId], kind: 'create' });

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

  const exists = canvas.nodes.some(n => n.id === nodeId);
  if (!exists) return { ok: false, error: `Node not found: ${nodeId}` };

  // Re-read canvas.json just before writing to preserve concurrent changes
  // to other nodes from the renderer or other canvas-cli invocations.
  const result = await commitNodeMutation(workspaceId, { removeId: nodeId }, storeDir);
  if (!result) return { ok: false, error: `Node not found: ${nodeId}` };
  await notifyCanvasUpdated({ workspaceId, nodeIds: [nodeId], kind: 'delete' });

  return { ok: true, data: undefined };
}

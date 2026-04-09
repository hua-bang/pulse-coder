/**
 * Canvas-specific tools for the Canvas Agent.
 *
 * These tools operate directly on the canvas filesystem (canvas.json + notes/)
 * in the Electron main process. They do NOT go through the CLI.
 *
 * Tool interface matches pulse-coder-engine's Tool type:
 *   { name, description, inputSchema (Zod), execute }
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  buildWorkspaceSummary,
  buildDetailedContext,
  readNodeDetail,
  formatSummaryForPrompt,
} from './context-builder';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

// ─── Types mirrored from canvas-cli ────────────────────────────────

type NodeType = 'file' | 'terminal' | 'frame' | 'agent';

interface CanvasNode {
  id: string;
  type: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
  updatedAt?: number;
}

interface CanvasSaveData {
  nodes: CanvasNode[];
  transform: { x: number; y: number; scale: number };
  savedAt: string;
}

const DEFAULT_DIMENSIONS: Record<NodeType, { title: string; width: number; height: number }> = {
  file: { title: 'Untitled', width: 420, height: 360 },
  terminal: { title: 'Terminal', width: 480, height: 300 },
  frame: { title: 'Frame', width: 600, height: 400 },
  agent: { title: 'Agent', width: 520, height: 380 },
};

// ─── Helpers ───────────────────────────────────────────────────────

function canvasPath(workspaceId: string): string {
  return join(STORE_DIR, workspaceId, 'canvas.json');
}

async function loadCanvas(workspaceId: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(canvasPath(workspaceId), 'utf-8');
    const data = JSON.parse(raw) as CanvasSaveData;
    data.nodes = data.nodes ?? [];
    return data;
  } catch {
    return null;
  }
}

async function saveCanvas(workspaceId: string, data: CanvasSaveData): Promise<void> {
  data.savedAt = new Date().toISOString();
  await fs.writeFile(canvasPath(workspaceId), JSON.stringify(data, null, 2), 'utf-8');
}

function broadcastUpdate(workspaceId: string, nodeIds: string[]): void {
  const payload = {
    type: 'canvas:updated' as const,
    workspaceId,
    nodeIds,
    source: 'canvas-agent' as const,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('canvas:external-update', payload);
  }
}

function autoPlace(nodes: CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 100, y: 100 };
  let maxRight = 0;
  let bestY = 100;
  for (const n of nodes) {
    const right = n.x + n.width;
    if (right > maxRight) {
      maxRight = right;
      bestY = n.y;
    }
  }
  return { x: maxRight + 40, y: bestY };
}

// ─── Canvas Tool type (matches Engine's Tool interface) ────────────

export interface CanvasTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: any) => Promise<string>;
}

// ─── Tool definitions ──────────────────────────────────────────────

export function createCanvasTools(workspaceId: string): Record<string, CanvasTool> {
  return {
    canvas_read_context: {
      name: 'canvas_read_context',
      description:
        'Read the current workspace context. Use detail="summary" (default) for a quick overview of all nodes, or detail="full" to include file contents and terminal scrollback.',
      inputSchema: z.object({
        detail: z.enum(['summary', 'full']).optional().describe('Level of detail. "summary" returns node list with metadata. "full" includes file contents and terminal scrollback.'),
      }),
      execute: async (input) => {
        const detail = input.detail ?? 'summary';
        if (detail === 'full') {
          const ctx = await buildDetailedContext(workspaceId);
          if (!ctx) return 'Error: workspace not found';
          return JSON.stringify(ctx, null, 2);
        }
        const summary = await buildWorkspaceSummary(workspaceId);
        if (!summary) return 'Error: workspace not found';
        return formatSummaryForPrompt(summary);
      },
    },

    canvas_read_node: {
      name: 'canvas_read_node',
      description:
        'Read the full content of a specific canvas node. For file nodes, returns the file content. For terminal/agent nodes, returns scrollback output.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to read.'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const detail = await readNodeDetail(workspaceId, nodeId);
        if (!detail) return `Error: node not found: ${nodeId}`;
        return JSON.stringify(detail, null, 2);
      },
    },

    canvas_create_node: {
      name: 'canvas_create_node',
      description:
        'Create a new node on the canvas.\n' +
        '- **file**: Creates a markdown note with a backing file. Use `content` for initial text.\n' +
        '- **terminal**: Spawns an interactive shell session on the canvas. The PTY starts automatically. Use `data.cwd` to set the working directory.\n' +
        '- **frame**: Creates a grouping container. Use `data.color` (hex) and `data.label`.\n' +
        '- **agent**: Creates an AI agent node (Claude Code, Codex, Pulse Coder). ' +
        'Set `data.agentType` ("claude-code" | "codex" | "pulse-coder"), `data.cwd` for the working directory, ' +
        'and `data.status` to "running" to auto-launch (default "idle" shows a picker). ' +
        'Optional `data.agentArgs` passes extra arguments to the agent command.',
      inputSchema: z.object({
        type: z.enum(['file', 'terminal', 'frame', 'agent']).describe('Node type.'),
        title: z.string().optional().describe('Node title.'),
        content: z.string().optional().describe('Initial content (for file nodes).'),
        x: z.number().optional().describe('X position (auto-placed if omitted).'),
        y: z.number().optional().describe('Y position (auto-placed if omitted).'),
        data: z.record(z.string(), z.unknown()).optional().describe(
          'Additional node data. Keys vary by type:\n' +
          '- terminal: { cwd?: string }\n' +
          '- agent: { agentType?: "claude-code"|"codex"|"pulse-coder", cwd?: string, status?: "idle"|"running", agentArgs?: string }\n' +
          '- frame: { color?: string, label?: string }',
        ),
      }),
      execute: async (input) => {
        const nodeType = input.type as NodeType;
        const title = (input.title as string) ?? DEFAULT_DIMENSIONS[nodeType]?.title ?? 'Untitled';
        const content = (input.content as string) ?? '';
        const extraData = (input.data as Record<string, unknown>) ?? {};

        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const def = DEFAULT_DIMENSIONS[nodeType];
        if (!def) return `Error: unsupported node type: ${nodeType}`;

        const pos = (input.x != null && input.y != null)
          ? { x: input.x as number, y: input.y as number }
          : autoPlace(canvas.nodes);

        let nodeData: Record<string, unknown>;
        switch (nodeType) {
          case 'file':
            nodeData = { filePath: '', content, saved: false, modified: false };
            break;
          case 'terminal':
            nodeData = { sessionId: '', cwd: (extraData.cwd as string) ?? '' };
            break;
          case 'frame':
            nodeData = {
              color: (extraData.color as string) ?? '#9575d4',
              label: (extraData.label as string) ?? '',
            };
            break;
          case 'agent': {
            const requestedStatus = (extraData.status as string) ?? 'idle';
            const validStatuses = ['idle', 'running'];
            const status = validStatuses.includes(requestedStatus) ? requestedStatus : 'idle';
            nodeData = {
              sessionId: '',
              cwd: (extraData.cwd as string) ?? '',
              agentType: (extraData.agentType as string) ?? 'claude-code',
              status,
              agentArgs: (extraData.agentArgs as string) ?? '',
            };
            break;
          }
        }

        // For file nodes, create a backing notes file
        if (nodeType === 'file') {
          const notesDir = join(STORE_DIR, workspaceId, 'notes');
          await fs.mkdir(notesDir, { recursive: true });
          const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_');
          const noteFile = join(notesDir, `${safeTitle}-${nodeId}.md`);
          await fs.writeFile(noteFile, content, 'utf-8');
          nodeData.filePath = noteFile;
          nodeData.saved = true;
          nodeData.modified = false;
        }

        const newNode: CanvasNode = {
          id: nodeId,
          type: nodeType,
          title,
          x: pos.x,
          y: pos.y,
          width: def.width,
          height: def.height,
          data: nodeData,
          updatedAt: Date.now(),
        };

        // Re-read canvas before writing to avoid clobbering concurrent changes
        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.nodes.push(newNode);
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({
          ok: true,
          nodeId,
          type: nodeType,
          title,
        });
      },
    },

    canvas_update_node: {
      name: 'canvas_update_node',
      description:
        'Update an existing canvas node. For file nodes, updates the file content. For frame nodes, updates label/color.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to update.'),
        title: z.string().optional().describe('New title (optional).'),
        content: z.string().optional().describe('New content for file nodes.'),
        data: z.record(z.string(), z.unknown()).optional().describe('Partial data update (e.g. label, color for frames).'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const node = canvas.nodes.find(n => n.id === nodeId);
        if (!node) return `Error: node not found: ${nodeId}`;

        if (input.title) node.title = input.title as string;

        if (node.type === 'file' && input.content != null) {
          const content = input.content as string;
          node.data.content = content;
          if (node.data.filePath) {
            await fs.writeFile(node.data.filePath as string, content, 'utf-8');
          }
        }

        if (input.data) {
          const patch = input.data as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch)) {
            node.data[k] = v;
          }
        }

        node.updatedAt = Date.now();

        // Re-read and commit
        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        const idx = fresh.nodes.findIndex(n => n.id === nodeId);
        if (idx >= 0) fresh.nodes[idx] = node;
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId });
      },
    },

    canvas_delete_node: {
      name: 'canvas_delete_node',
      description: 'Delete a node from the canvas.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to delete.'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const idx = canvas.nodes.findIndex(n => n.id === nodeId);
        if (idx === -1) return `Error: node not found: ${nodeId}`;

        // Re-read and commit
        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        const freshIdx = fresh.nodes.findIndex(n => n.id === nodeId);
        if (freshIdx >= 0) fresh.nodes.splice(freshIdx, 1);
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId });
      },
    },

    canvas_move_node: {
      name: 'canvas_move_node',
      description: 'Move a node to a new position on the canvas.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to move.'),
        x: z.number().describe('New X position.'),
        y: z.number().describe('New Y position.'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const node = canvas.nodes.find(n => n.id === nodeId);
        if (!node) return `Error: node not found: ${nodeId}`;

        node.x = input.x as number;
        node.y = input.y as number;
        node.updatedAt = Date.now();

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        const idx = fresh.nodes.findIndex(n => n.id === nodeId);
        if (idx >= 0) fresh.nodes[idx] = node;
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId });
      },
    },
  };
}

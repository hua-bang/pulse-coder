/**
 * Context builder for the Canvas Agent.
 *
 * Produces a lightweight workspace summary (always injected into system prompt)
 * and a detailed context (loaded on demand via canvas_read_context tool).
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { NodeSummary, WorkspaceSummary } from './types';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

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

interface WorkspaceManifest {
  workspaces: Array<{ id: string; name: string }>;
  activeId?: string;
}

// ─── Low-level readers ─────────────────────────────────────────────

async function loadCanvasJson(workspaceId: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, workspaceId, 'canvas.json'), 'utf-8');
    return JSON.parse(raw) as CanvasSaveData;
  } catch {
    return null;
  }
}

async function loadManifest(): Promise<WorkspaceManifest> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, '__workspaces__.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const workspaces = (parsed.workspaces ?? parsed.entries ?? []) as WorkspaceManifest['workspaces'];
    return { workspaces, activeId: parsed.activeId as string | undefined };
  } catch {
    return { workspaces: [] };
  }
}

/**
 * Resolve a set of workspaceIds to `{ id, name }` pairs using the on-disk
 * manifest. IDs that don't exist in the manifest still come back, with their
 * name falling back to the ID itself so the caller can always reference them.
 */
export async function resolveWorkspaceNames(
  workspaceIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (workspaceIds.length === 0) return [];
  const manifest = await loadManifest();
  const byId = new Map(manifest.workspaces.map(w => [w.id, w.name] as const));
  return workspaceIds.map(id => ({ id, name: byId.get(id) ?? id }));
}

// ─── Summary builder ───────────────────────────────────────────────

function summarizeNode(node: CanvasNode): NodeSummary {
  const summary: NodeSummary = {
    id: node.id,
    type: node.type,
    title: node.title,
  };

  switch (node.type) {
    case 'file':
      summary.path = (node.data.filePath as string) || undefined;
      break;
    case 'terminal':
      summary.path = (node.data.cwd as string) || undefined;
      break;
    case 'agent':
      summary.path = (node.data.cwd as string) || undefined;
      summary.agentType = (node.data.agentType as string) || 'claude-code';
      summary.status = (node.data.status as string) || 'idle';
      break;
    case 'frame':
      summary.color = (node.data.color as string) || undefined;
      summary.label = (node.data.label as string) || undefined;
      break;
  }

  return summary;
}

/**
 * Build a lightweight workspace summary. This is cheap and always injected
 * into the Canvas Agent's system prompt so it "knows what's on the canvas".
 */
export async function buildWorkspaceSummary(workspaceId: string): Promise<WorkspaceSummary | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const manifest = await loadManifest();
  const entry = manifest.workspaces.find(e => e.id === workspaceId);
  const workspaceName = entry?.name ?? workspaceId;
  const canvasDir = join(STORE_DIR, workspaceId);

  return {
    workspaceId,
    workspaceName,
    canvasDir,
    nodeCount: canvas.nodes.length,
    nodes: canvas.nodes.map(summarizeNode),
  };
}

// ─── Detailed context (on-demand) ──────────────────────────────────

interface DetailedNodeContext extends NodeSummary {
  content?: string;
  scrollback?: string;
  cwd?: string;
}

interface DetailedWorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  canvasDir: string;
  nodes: DetailedNodeContext[];
  agentsMd?: string;
}

/**
 * Build a full detailed context including file contents and terminal
 * scrollback. This is expensive and only loaded via the canvas_read_context
 * tool when the agent needs deep context.
 */
export async function buildDetailedContext(workspaceId: string): Promise<DetailedWorkspaceContext | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const manifest = await loadManifest();
  const entry = manifest.workspaces.find(e => e.id === workspaceId);
  const workspaceName = entry?.name ?? workspaceId;
  const canvasDir = join(STORE_DIR, workspaceId);

  const nodes: DetailedNodeContext[] = [];

  for (const node of canvas.nodes) {
    const base = summarizeNode(node);
    const detailed: DetailedNodeContext = { ...base };

    switch (node.type) {
      case 'file': {
        const filePath = node.data.filePath as string;
        if (filePath) {
          try {
            detailed.content = await fs.readFile(filePath, 'utf-8');
          } catch {
            detailed.content = (node.data.content as string) ?? '';
          }
        } else {
          detailed.content = (node.data.content as string) ?? '';
        }
        break;
      }
      case 'terminal':
        detailed.scrollback = (node.data.scrollback as string) ?? '';
        detailed.cwd = (node.data.cwd as string) ?? '';
        break;
      case 'agent':
        detailed.scrollback = (node.data.scrollback as string) ?? '';
        detailed.cwd = (node.data.cwd as string) ?? '';
        break;
    }

    nodes.push(detailed);
  }

  // Read AGENTS.md if present
  let agentsMd: string | undefined;
  try {
    agentsMd = await fs.readFile(join(canvasDir, 'AGENTS.md'), 'utf-8');
  } catch {
    // not present
  }

  return { workspaceId, workspaceName, canvasDir, nodes, agentsMd };
}

// ─── Read a single node in detail ──────────────────────────────────

export async function readNodeDetail(workspaceId: string, nodeId: string): Promise<DetailedNodeContext | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const node = canvas.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const base = summarizeNode(node);
  const detailed: DetailedNodeContext = { ...base };

  switch (node.type) {
    case 'file': {
      const filePath = node.data.filePath as string;
      if (filePath) {
        try {
          detailed.content = await fs.readFile(filePath, 'utf-8');
        } catch {
          detailed.content = (node.data.content as string) ?? '';
        }
      } else {
        detailed.content = (node.data.content as string) ?? '';
      }
      break;
    }
    case 'terminal':
      detailed.scrollback = (node.data.scrollback as string) ?? '';
      detailed.cwd = (node.data.cwd as string) ?? '';
      break;
    case 'agent':
      detailed.scrollback = (node.data.scrollback as string) ?? '';
      detailed.cwd = (node.data.cwd as string) ?? '';
      break;
    case 'frame':
      // nothing extra beyond summary
      break;
  }

  return detailed;
}

// ─── Format summary as system prompt section ───────────────────────

export function formatSummaryForPrompt(summary: WorkspaceSummary): string {
  const lines: string[] = [
    `# Canvas Workspace: ${summary.workspaceName}`,
    `Workspace ID: ${summary.workspaceId}`,
    `Canvas directory: ${summary.canvasDir}`,
    `Total nodes: ${summary.nodeCount}`,
    '',
  ];

  const byType: Record<string, NodeSummary[]> = {};
  for (const node of summary.nodes) {
    (byType[node.type] ??= []).push(node);
  }

  if (byType.file?.length) {
    lines.push('## File Nodes');
    for (const n of byType.file) {
      const pathHint = n.path ? ` (${n.path})` : ' (unsaved)';
      lines.push(`- [${n.id}] **${n.title}**${pathHint}`);
    }
    lines.push('');
  }

  if (byType.frame?.length) {
    lines.push('## Frames');
    for (const n of byType.frame) {
      const labelHint = n.label ? ` — ${n.label}` : '';
      lines.push(`- [${n.id}] **${n.title}**${labelHint}`);
    }
    lines.push('');
  }

  if (byType.terminal?.length) {
    lines.push('## Terminals');
    for (const n of byType.terminal) {
      const cwdHint = n.path ? ` (cwd: ${n.path})` : '';
      lines.push(`- [${n.id}] **${n.title}**${cwdHint}`);
    }
    lines.push('');
  }

  if (byType.agent?.length) {
    lines.push('## Agent Nodes');
    for (const n of byType.agent) {
      const info = `${n.agentType ?? 'unknown'}, ${n.status ?? 'idle'}`;
      const cwdHint = n.path ? `, cwd: ${n.path}` : '';
      lines.push(`- [${n.id}] **${n.title}** (${info}${cwdHint})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

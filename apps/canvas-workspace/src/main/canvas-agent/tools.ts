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
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  buildWorkspaceSummary,
  buildDetailedContext,
  readNodeDetail,
  formatSummaryForPrompt,
} from './context-builder';
import { hasSession, writeToSession } from '../pty-manager';
import { generateHTML } from '../html-generator';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

// ─── Types mirrored from canvas-cli ────────────────────────────────

type NodeType = 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'shape';

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

type EdgeAnchor = 'top' | 'right' | 'bottom' | 'left' | 'auto';

type EdgeEndpoint =
  | { kind: 'node'; nodeId: string; anchor?: EdgeAnchor }
  | { kind: 'point'; x: number; y: number };

type EdgeArrowCap = 'none' | 'triangle' | 'arrow' | 'dot' | 'bar';

interface EdgeStroke {
  color?: string;
  width?: number;
  style?: 'solid' | 'dashed' | 'dotted';
}

interface CanvasEdge {
  id: string;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  bend?: number;
  arrowHead?: EdgeArrowCap;
  arrowTail?: EdgeArrowCap;
  stroke?: EdgeStroke;
  label?: string;
  kind?: string;
  payload?: Record<string, unknown>;
  updatedAt?: number;
}

interface CanvasSaveData {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  transform: { x: number; y: number; scale: number };
  savedAt: string;
}

const DEFAULT_DIMENSIONS: Record<NodeType, { title: string; width: number; height: number }> = {
  file: { title: 'Untitled', width: 420, height: 360 },
  terminal: { title: 'Terminal', width: 480, height: 300 },
  frame: { title: 'Frame', width: 600, height: 400 },
  agent: { title: 'Agent', width: 520, height: 380 },
  text: { title: 'Text', width: 260, height: 120 },
  iframe: { title: 'Web', width: 520, height: 400 },
  shape: { title: 'Shape', width: 200, height: 140 },
};

// ─── Helpers ───────────────────────────────────────────────────────

function canvasPath(workspaceId: string): string {
  return join(STORE_DIR, workspaceId, 'canvas.json');
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Load `canvas.json` for a workspace.
 *
 * Returns `null` ONLY when the file is genuinely missing (ENOENT). Any
 * other failure (I/O error, JSON parse error from catching another writer
 * mid-flush) is rethrown so callers don't confuse "unreadable right now"
 * with "doesn't exist" and wipe real data by bootstrapping an empty
 * canvas. This mirrors `packages/canvas-cli/src/core/store.ts#loadCanvas`.
 */
async function loadCanvas(workspaceId: string): Promise<CanvasSaveData | null> {
  let raw: string;
  try {
    raw = await fs.readFile(canvasPath(workspaceId), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    const data = JSON.parse(raw) as CanvasSaveData;
    data.nodes = data.nodes ?? [];
    return data;
  } catch (err) {
    // Parse failure almost always means another writer caught mid-flush.
    // Do NOT return null here — the caller might treat that as "no canvas"
    // and overwrite real user data with an empty bootstrap.
    throw new Error(
      `[canvas-agent] failed to parse canvas.json for workspace "${workspaceId}": ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface SaveCanvasOptions {
  /**
   * Allow writing an empty `nodes: []` even when the on-disk canvas
   * currently has nodes. Default false: the write is refused to protect
   * against accidental wipes (buggy caller, partially-loaded snapshot).
   * Opt in for flows that legitimately end up with zero nodes, such as
   * deleting the last remaining node.
   */
  allowEmpty?: boolean;
}

async function saveCanvas(
  workspaceId: string,
  data: CanvasSaveData,
  opts: SaveCanvasOptions = {},
): Promise<void> {
  data.savedAt = new Date().toISOString();

  // Mirror the guard in canvas-store.ts / packages/canvas-cli so every
  // write path into canvas.json refuses to silently clobber existing
  // nodes with an empty list.
  if (!opts.allowEmpty && Array.isArray(data.nodes) && data.nodes.length === 0) {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(canvasPath(workspaceId), 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) {
        // Can't verify what's on disk — refuse rather than risk wiping a
        // populated canvas that just happened to be unreadable this turn.
        throw new Error(
          `[canvas-agent] failed to read canvas.json while guarding empty write ` +
          `for workspace "${workspaceId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // ENOENT → nothing on disk, fall through and write.
    }
    if (raw !== null) {
      let existingNodes: CanvasNode[];
      try {
        const existing = JSON.parse(raw) as CanvasSaveData;
        existingNodes = Array.isArray(existing.nodes) ? existing.nodes : [];
      } catch (err) {
        // Parse failure mid-flight: treating "unparseable" as "nothing to
        // protect" is exactly how silent wipes happen. Refuse the write.
        throw new Error(
          `[canvas-agent] failed to parse existing canvas.json while guarding empty write ` +
          `for workspace "${workspaceId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (existingNodes.length > 0) {
        throw new Error(
          `[canvas-agent] refusing to overwrite ${existingNodes.length} on-disk nodes ` +
          `with empty nodes for workspace "${workspaceId}". ` +
          `Pass { allowEmpty: true } to saveCanvas if this wipe is intentional.`,
        );
      }
    }
  }

  await atomicWriteCanvasJson(canvasPath(workspaceId), JSON.stringify(data, null, 2));
}

/**
 * Atomically persist a canvas.json update with a rolling `.bak` backup.
 * Mirrors the helper in `apps/canvas-workspace/src/main/canvas-store.ts`
 * and `packages/canvas-cli/src/core/store.ts` so every writer uses the
 * same safe rename-based write; see those files for the full rationale.
 */
async function atomicWriteCanvasJson(
  finalPath: string,
  serialized: string,
): Promise<void> {
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  const tmpPath = join(dir, `${base}.tmp`);
  const bakPath = join(dir, `${base}.bak`);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, 'utf-8');

  try {
    const currentRaw = await fs.readFile(finalPath, 'utf-8');
    try {
      const current = JSON.parse(currentRaw) as { nodes?: unknown[] };
      if (Array.isArray(current.nodes) && current.nodes.length > 0) {
        await fs.copyFile(finalPath, bakPath).catch(() => undefined);
      }
    } catch {
      // Current file already corrupt — leave existing .bak alone.
    }
  } catch {
    // No current file; nothing to back up.
  }

  await fs.rename(tmpPath, finalPath);
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

/**
 * Subset of pulse-coder-engine's ToolExecutionContext that canvas tools may
 * use. Kept loose so the shim (engine.d.ts) does not need to export this type.
 */
export interface CanvasToolExecutionContext {
  /** Called when a tool needs to ask the user a clarifying question. */
  onClarificationRequest?: (request: {
    id: string;
    question: string;
    context?: string;
    defaultAnswer?: string;
    timeout: number;
  }) => Promise<string>;
  /** Abort signal for the current engine run. */
  abortSignal?: AbortSignal;
}

export interface CanvasTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: any, ctx?: CanvasToolExecutionContext) => Promise<string>;
}

/** Prompts shorter than this are passed directly as CLI args; longer ones go to a file. */
const INLINE_PROMPT_THRESHOLD = 256;

let edgeIdCounter = 0;
function genEdgeId(): string {
  return `edge-${Date.now()}-${++edgeIdCounter}`;
}

/**
 * Short human-readable title for an edge endpoint, used when describing
 * connections back to the agent. Falls back to `point(x, y)` for free
 * endpoints and `[id]` for unresolved nodes.
 */
function describeEndpoint(endpoint: EdgeEndpoint, nodesById: Map<string, CanvasNode>): string {
  if (endpoint.kind === 'point') {
    return `point(${Math.round(endpoint.x)}, ${Math.round(endpoint.y)})`;
  }
  const node = nodesById.get(endpoint.nodeId);
  if (!node) return `[${endpoint.nodeId}] (missing)`;
  return `[${node.id}] "${node.title || node.type}"`;
}

/**
 * Build an EdgeEndpoint from the flat source/target fields on the tool
 * input. Prefers `nodeId` when both a node ref and explicit x/y are
 * supplied, and throws if neither is provided.
 */
function buildEndpoint(args: {
  nodeId?: string;
  anchor?: string;
  x?: number;
  y?: number;
  which: 'source' | 'target';
}): EdgeEndpoint {
  if (args.nodeId) {
    const anchor = (args.anchor as EdgeAnchor | undefined) ?? 'auto';
    return { kind: 'node', nodeId: args.nodeId, anchor };
  }
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    return { kind: 'point', x: args.x, y: args.y };
  }
  throw new Error(
    `canvas_create_edge: ${args.which} endpoint needs either \`${args.which}NodeId\` ` +
      `or both \`${args.which}X\` and \`${args.which}Y\`.`,
  );
}

// ─── Tool definitions ──────────────────────────────────────────────

export function createCanvasTools(workspaceId: string): Record<string, CanvasTool> {
  return {
    canvas_ask_user: {
      name: 'canvas_ask_user',
      description:
        'Ask the user a clarifying question and wait for their reply. Use this whenever you need more information, a choice between options, or confirmation before proceeding. Do NOT guess — ask.',
      inputSchema: z.object({
        question: z.string().describe('The question to ask the user. Be concise and specific.'),
        context: z.string().optional().describe('Optional extra context to help the user answer.'),
      }),
      execute: async (input, ctx) => {
        const ask = ctx?.onClarificationRequest;
        if (!ask) {
          return 'Clarification is not supported in this context. Proceed with best judgement.';
        }
        const signal = ctx?.abortSignal;
        const requestId = randomUUID();
        const askPromise = ask({
          id: requestId,
          question: input.question,
          context: input.context,
          timeout: 0,
        });
        if (!signal) return askPromise;
        return await new Promise<string>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          const onAbort = () => reject(new Error('Aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          askPromise.then(
            (answer) => {
              signal.removeEventListener('abort', onAbort);
              resolve(answer);
            },
            (err) => {
              signal.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      },
    },

    canvas_read_context: {
      name: 'canvas_read_context',
      description:
        'Read a workspace context. Defaults to the current workspace; pass `workspaceId` to read a different canvas the user has `@`-mentioned. ' +
        'Use detail="summary" (default) for a quick overview of all nodes, or detail="full" to include file contents and terminal scrollback.',
      inputSchema: z.object({
        detail: z.enum(['summary', 'full']).optional().describe('Level of detail. "summary" returns node list with metadata. "full" includes file contents and terminal scrollback.'),
        workspaceId: z.string().optional().describe('Target workspace ID. Defaults to the current workspace. Use this to read another canvas the user @-mentioned.'),
      }),
      execute: async (input) => {
        const detail = input.detail ?? 'summary';
        const targetWorkspaceId = (input.workspaceId as string) || workspaceId;
        if (detail === 'full') {
          const ctx = await buildDetailedContext(targetWorkspaceId);
          if (!ctx) return `Error: workspace not found: ${targetWorkspaceId}`;
          return JSON.stringify(ctx, null, 2);
        }
        const summary = await buildWorkspaceSummary(targetWorkspaceId);
        if (!summary) return `Error: workspace not found: ${targetWorkspaceId}`;
        return formatSummaryForPrompt(summary);
      },
    },

    canvas_read_node: {
      name: 'canvas_read_node',
      description:
        'Read the full content of a specific canvas node. For file nodes, returns the file content. For terminal/agent nodes, returns scrollback output. ' +
        'For iframe/link nodes, fetches the URL and returns the page text (HTML stripped, capped at ~200KB). ' +
        'Defaults to the current workspace; pass `workspaceId` to read a node from another canvas the user `@`-mentioned.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to read.'),
        workspaceId: z.string().optional().describe('Target workspace ID. Defaults to the current workspace.'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const targetWorkspaceId = (input.workspaceId as string) || workspaceId;
        const detail = await readNodeDetail(targetWorkspaceId, nodeId);
        if (!detail) return `Error: node not found: ${nodeId} (workspace: ${targetWorkspaceId})`;
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
        'Use `data.prompt` to inject a task/context — it is written to a file in the cwd and piped directly ' +
        'to the agent as its initial prompt. Include relevant canvas content so the agent knows the context. ' +
        'Optional `data.agentArgs` overrides the auto-generated CLI arguments.\n' +
        '- **text**: Creates a free-form text label (TLDRAW-style). Use `content` for the text body, ' +
        'and `data.textColor` / `data.backgroundColor` (hex or "transparent") for styling. Optional `data.fontSize`.\n' +
        '- **iframe**: Embeds an external web page, renders raw HTML, or generates HTML from a prompt. ' +
        'For URL mode: pass `data.url` with the full URL (including protocol). ' +
        'For HTML mode: pass `data.html` with raw HTML content and `data.mode: "html"`. ' +
        'For AI mode: pass `data.prompt` with a description and `data.mode: "ai"` — ' +
        'the LLM will generate self-contained HTML. ' +
        'Note: some sites block URL embedding via X-Frame-Options / CSP.\n' +
        '- **shape**: Draws a primitive geometric shape (rectangle or ellipse). ' +
        'Use `data.kind` ("rect" | "ellipse"), `data.fill` / `data.stroke` (hex or "transparent"), ' +
        'and `data.strokeWidth` (px). For precise sizing pass explicit `x`, `y`, and set width/height ' +
        'via the dedicated `canvas_create_shape` tool — this generic one uses default dimensions.',
      inputSchema: z.object({
        type: z.enum(['file', 'terminal', 'frame', 'agent', 'text', 'iframe', 'shape']).describe('Node type.'),
        title: z.string().optional().describe('Node title.'),
        content: z.string().optional().describe('Initial content (for file and text nodes).'),
        x: z.number().optional().describe('X position (auto-placed if omitted).'),
        y: z.number().optional().describe('Y position (auto-placed if omitted).'),
        data: z.record(z.string(), z.unknown()).optional().describe(
          'Additional node data. Keys vary by type:\n' +
          '- terminal: { cwd?: string }\n' +
          '- agent: { agentType?: "claude-code"|"codex"|"pulse-coder", cwd?: string, status?: "idle"|"running", prompt?: string, agentArgs?: string }\n' +
          '- frame: { color?: string, label?: string }\n' +
          '- text: { textColor?: string, backgroundColor?: string, fontSize?: number }\n' +
          '- iframe: { url?: string, html?: string, prompt?: string, mode?: "url"|"html"|"ai" }\n' +
          '- shape: { kind?: "rect"|"ellipse", fill?: string, stroke?: string, strokeWidth?: number, text?: string, textColor?: string, fontSize?: number }',
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
            const agentCwd = (extraData.cwd as string) ?? '';
            const prompt = (extraData.prompt as string) ?? '';
            const agentArgs = (extraData.agentArgs as string) ?? '';

            // Short prompt → inline CLI arg; long prompt → file
            let inlinePrompt = '';
            let promptFile = '';
            if (prompt && agentCwd) {
              if (prompt.length <= INLINE_PROMPT_THRESHOLD) {
                inlinePrompt = prompt;
              } else {
                promptFile = '.canvas-agent-task.md';
                await fs.mkdir(agentCwd, { recursive: true });
                await fs.writeFile(join(agentCwd, promptFile), prompt, 'utf-8');
              }
            }

            nodeData = {
              sessionId: '',
              cwd: agentCwd,
              agentType: (extraData.agentType as string) ?? 'claude-code',
              status,
              agentArgs,
              inlinePrompt,
              promptFile,
            };
            break;
          }
          case 'text':
            nodeData = {
              content,
              textColor: (extraData.textColor as string) ?? '#1f2328',
              backgroundColor: (extraData.backgroundColor as string) ?? 'transparent',
              fontSize: (extraData.fontSize as number) ?? 18,
            };
            break;
          case 'iframe': {
            const rawMode = extraData.mode as string | undefined;
            const iframeMode = rawMode === 'html' ? 'html' : rawMode === 'ai' ? 'ai' : 'url';
            const prompt = (extraData.prompt as string) ?? '';

            if (iframeMode === 'ai' && prompt) {
              // Generate HTML from the prompt via LLM
              const genResult = await generateHTML(prompt);
              nodeData = {
                url: '',
                html: genResult.ok ? (genResult.html ?? '') : `<pre style="color:red">${genResult.error ?? 'Generation failed'}</pre>`,
                prompt,
                mode: 'ai',
              };
            } else {
              nodeData = {
                url: (extraData.url as string) ?? '',
                html: (extraData.html as string) ?? '',
                prompt,
                mode: iframeMode,
              };
            }
            break;
          }
          case 'shape': {
            const rawKind = extraData.kind as string | undefined;
            const shapeKind = rawKind === 'ellipse' ? 'ellipse' : 'rect';
            nodeData = {
              kind: shapeKind,
              fill: (extraData.fill as string) ?? '#E8EEF7',
              stroke: (extraData.stroke as string) ?? '#5B7CBF',
              strokeWidth: (extraData.strokeWidth as number) ?? 2,
              text: (extraData.text as string) ?? (content || ''),
              textColor: extraData.textColor as string | undefined,
              fontSize: extraData.fontSize as number | undefined,
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
        'Update an existing canvas node. For file and text nodes, updates `content`. For frame nodes, updates label/color. For text nodes, `data.textColor`/`data.backgroundColor`/`data.fontSize` can also be patched.',
      inputSchema: z.object({
        nodeId: z.string().describe('The ID of the node to update.'),
        title: z.string().optional().describe('New title (optional).'),
        content: z.string().optional().describe('New content for file and text nodes.'),
        data: z.record(z.string(), z.unknown()).optional().describe('Partial data update (e.g. label, color for frames; textColor, backgroundColor, fontSize for text).'),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;

        // First load drives validation and the file-side effect (if any).
        // We read the backing file path from this snapshot because file
        // path is set once at create-time and stable across writers.
        const initial = await loadCanvas(workspaceId);
        if (!initial) return 'Error: workspace not found';
        const initialNode = initial.nodes.find(n => n.id === nodeId);
        if (!initialNode) return `Error: node not found: ${nodeId}`;

        // Side effect on the backing notes file. Done before re-read so a
        // concurrent canvas write that lands between the two reads still
        // sees consistent state (the file content and `data.content` will
        // both reflect this update once the canvas write commits).
        if (initialNode.type === 'file' && input.content != null && initialNode.data.filePath) {
          await fs.writeFile(
            initialNode.data.filePath as string,
            input.content as string,
            'utf-8',
          );
        }

        // Re-read immediately before mutating so concurrent updates to
        // OTHER fields of this node by another writer (renderer save,
        // canvas-cli, MCP) survive. The previous code mutated the stale
        // `initialNode` and spliced it back into the fresh canvas, which
        // silently clobbered any concurrent changes to that node.
        const fresh = (await loadCanvas(workspaceId)) ?? initial;
        const idx = fresh.nodes.findIndex(n => n.id === nodeId);
        if (idx === -1) {
          // The node was deleted between our two reads. Do not resurrect
          // it by re-inserting our patched copy — surface the conflict.
          return `Error: node ${nodeId} was deleted concurrently; update aborted`;
        }
        const node = fresh.nodes[idx];

        if (input.title) node.title = input.title as string;
        if (node.type === 'file' && input.content != null) {
          node.data.content = input.content as string;
        }
        if (node.type === 'text' && input.content != null) {
          node.data.content = input.content as string;
        }
        if (input.data) {
          const patch = input.data as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch)) {
            node.data[k] = v;
          }
        }
        node.updatedAt = Date.now();

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
        // Deleting the last remaining node legitimately leaves nodes=[];
        // opt in so the wipe guard doesn't refuse that case.
        await saveCanvas(workspaceId, fresh, { allowEmpty: true });
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

        // Single read against the latest disk state, then mutate that
        // snapshot in place. Reading once (instead of load → mutate-stale
        // → re-read → splice) means concurrent updates to OTHER fields of
        // this node — last edit by the user, content changes from the
        // CLI — are not silently overwritten with a pre-move copy.
        const fresh = await loadCanvas(workspaceId);
        if (!fresh) return 'Error: workspace not found';
        const idx = fresh.nodes.findIndex(n => n.id === nodeId);
        if (idx === -1) return `Error: node not found: ${nodeId}`;
        const node = fresh.nodes[idx];

        node.x = input.x as number;
        node.y = input.y as number;
        node.updatedAt = Date.now();

        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId });
      },
    },

    // ─── Dedicated agent node creation ──────────────────────────────

    canvas_create_agent_node: {
      name: 'canvas_create_agent_node',
      description:
        'Create and optionally auto-launch an AI agent node on the canvas. ' +
        'Use this when you need to delegate a task to another agent (Claude Code, Codex, Pulse Coder). ' +
        'Set `prompt` with task instructions and relevant canvas context so the agent knows what to do. ' +
        'The prompt is piped directly to the agent as its initial prompt.',
      inputSchema: z.object({
        title: z.string().optional().describe('Node title (e.g. "Codex: Implement login").'),
        agentType: z.enum(['claude-code', 'codex', 'pulse-coder']).optional()
          .describe('Agent type. Defaults to "claude-code".'),
        cwd: z.string().describe('Working directory for the agent.'),
        prompt: z.string().optional()
          .describe('Task instructions and context for the agent. Written to .canvas-agent-task.md in cwd. Include relevant canvas content (file contents, PRDs, terminal output, etc.) so the agent has full context.'),
        autoLaunch: z.boolean().optional()
          .describe('Set to true to launch the agent immediately (default: true when prompt is provided, false otherwise).'),
        agentArgs: z.string().optional()
          .describe('Override the auto-generated CLI arguments. Rarely needed when using prompt.'),
        x: z.number().optional().describe('X position (auto-placed if omitted).'),
        y: z.number().optional().describe('Y position (auto-placed if omitted).'),
      }),
      execute: async (input) => {
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const agentType = (input.agentType as string) ?? 'claude-code';
        const cwd = input.cwd as string;
        const prompt = (input.prompt as string) ?? '';
        const agentArgs = (input.agentArgs as string) ?? '';
        const autoLaunch = input.autoLaunch ?? !!prompt;
        const title = (input.title as string) ?? DEFAULT_DIMENSIONS.agent.title;

        // Short prompt → inline CLI arg; long prompt → file
        let inlinePrompt = '';
        let promptFile = '';
        if (prompt && cwd) {
          if (prompt.length <= INLINE_PROMPT_THRESHOLD) {
            inlinePrompt = prompt;
          } else {
            promptFile = '.canvas-agent-task.md';
            await fs.mkdir(cwd, { recursive: true });
            await fs.writeFile(join(cwd, promptFile), prompt, 'utf-8');
          }
        }

        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const def = DEFAULT_DIMENSIONS.agent;
        const pos = (input.x != null && input.y != null)
          ? { x: input.x as number, y: input.y as number }
          : autoPlace(canvas.nodes);

        const newNode: CanvasNode = {
          id: nodeId,
          type: 'agent',
          title,
          x: pos.x,
          y: pos.y,
          width: def.width,
          height: def.height,
          data: {
            sessionId: '',
            cwd,
            agentType,
            status: autoLaunch ? 'running' : 'idle',
            agentArgs,
            inlinePrompt,
            promptFile,
          },
          updatedAt: Date.now(),
        };

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.nodes.push(newNode);
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId, agentType, title, autoLaunch });
      },
    },

    // ─── Follow-up input to an existing agent node ──────────────────

    canvas_send_to_agent: {
      name: 'canvas_send_to_agent',
      description:
        'Send a follow-up prompt to an existing, RUNNING agent node (Claude Code / Codex / Pulse Coder). ' +
        'Writes the text directly to the agent\'s PTY as if the user typed it, and auto-appends Enter ' +
        '(a carriage return) so the agent receives and executes it immediately — you do NOT need to ' +
        'call this twice or send a separate newline. ' +
        'Use this for any interaction AFTER the initial launch: follow-up questions, corrections, ' +
        'redirections, approvals, etc. ' +
        'For the FIRST launch of a brand-new agent, use `canvas_create_agent_node` instead. ' +
        'Requirements: the target node must be `type="agent"`, `status="running"`, and its backing PTY ' +
        'session must still be alive (the agent node must be open in the canvas UI — closing the node ' +
        'tears down the PTY).',
      inputSchema: z.object({
        nodeId: z.string().describe('The agent node ID to send the prompt to.'),
        input: z.string().describe(
          'The text to send. Enter is appended automatically, so provide exactly what you want the ' +
          'agent to receive as one submission — no trailing newline needed.',
        ),
      }),
      execute: async (input) => {
        const nodeId = input.nodeId as string;
        const text = (input.input as string) ?? '';

        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const node = canvas.nodes.find(n => n.id === nodeId);
        if (!node) return `Error: node not found: ${nodeId}`;
        if (node.type !== 'agent') {
          return `Error: canvas_send_to_agent only works on agent nodes (got "${node.type}"). ` +
            'For terminal nodes use the MCP `canvas_exec` tool; for file/frame nodes use `canvas_update_node`.';
        }

        const status = (node.data.status as string) ?? 'idle';
        if (status !== 'running') {
          return `Error: agent node "${node.title}" is not running (status="${status}"). ` +
            'The agent must have been launched (status="running") before you can send follow-up input. ' +
            'Create a new agent node with a prompt, or ask the user to launch this one.';
        }

        const sessionId = (node.data.sessionId as string) ?? '';
        if (!sessionId || !hasSession(sessionId)) {
          return `Error: agent node "${node.title}" has no active PTY session. ` +
            'The agent node must be open in the canvas UI — closing or collapsing the node tears ' +
            'down its PTY. Ask the user to reopen the node, or relaunch the agent.';
        }

        // Strip any trailing CR/LF the caller might have included so we
        // control the submit signal ourselves.
        const body = text.replace(/[\r\n]+$/, '');

        // Write body and Enter as TWO separate writes with a small gap.
        //
        // Why: some TUI agents (notably Codex, which uses a ratatui-style
        // input editor with paste protection) distinguish "paste" from
        // "keystroke" by timing. If the text body and the \r arrive in the
        // same read, the \r gets absorbed into the editor buffer as a
        // literal newline and the prompt is never submitted — you end up
        // with the text sitting in the input box waiting for a real Enter.
        // Writing the body, yielding the event loop for ~120ms, then
        // writing \r as a second call makes the Enter arrive as an
        // independent keystroke, which Codex's editor treats as submit.
        // Claude Code is happy either way, so this is safe for all
        // agent types.
        if (body) {
          if (!writeToSession(sessionId, body)) {
            return `Error: failed to write to PTY session ${sessionId} (session disappeared).`;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        }
        if (!writeToSession(sessionId, '\r')) {
          return `Error: failed to write Enter to PTY session ${sessionId} (session disappeared).`;
        }

        return JSON.stringify({
          ok: true,
          nodeId,
          bytesSent: body.length + 1,
        });
      },
    },

    // ─── Dedicated terminal node creation ───────────────────────────

    canvas_create_terminal_node: {
      name: 'canvas_create_terminal_node',
      description:
        'Create and spawn an interactive terminal node on the canvas. ' +
        'The shell starts automatically. Use `command` to execute a command after the shell is ready ' +
        '(e.g. "npm run dev", "docker compose up").',
      inputSchema: z.object({
        title: z.string().optional().describe('Node title (e.g. "Dev Server", "Build"). Defaults to "Terminal".'),
        cwd: z.string().optional().describe('Working directory for the shell. Defaults to workspace root.'),
        command: z.string().optional().describe('Shell command to execute automatically after spawn (e.g. "npm run dev").'),
        x: z.number().optional().describe('X position (auto-placed if omitted).'),
        y: z.number().optional().describe('Y position (auto-placed if omitted).'),
      }),
      execute: async (input) => {
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const title = (input.title as string) ?? DEFAULT_DIMENSIONS.terminal.title;
        const cwd = (input.cwd as string) ?? '';
        const initialCommand = (input.command as string) ?? '';

        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const def = DEFAULT_DIMENSIONS.terminal;
        const pos = (input.x != null && input.y != null)
          ? { x: input.x as number, y: input.y as number }
          : autoPlace(canvas.nodes);

        const newNode: CanvasNode = {
          id: nodeId,
          type: 'terminal',
          title,
          x: pos.x,
          y: pos.y,
          width: def.width,
          height: def.height,
          data: { sessionId: '', cwd, initialCommand },
          updatedAt: Date.now(),
        };

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.nodes.push(newNode);
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId, title });
      },
    },

    // ─── Dedicated shape node creation ──────────────────────────────

    canvas_create_shape: {
      name: 'canvas_create_shape',
      description:
        'Create a primitive geometric shape (rectangle or ellipse) on the canvas. ' +
        'Shapes are visual-only annotations — they render as SVG primitives with configurable ' +
        'fill, stroke, and stroke width. Use this for diagramming, highlighting regions, or ' +
        'building simple layouts. ' +
        'Pass explicit width/height for precise sizing; otherwise defaults to 200×140. ' +
        'Colors accept hex strings (e.g. "#E8EEF7") or the literal string "transparent".',
      inputSchema: z.object({
        kind: z.enum(['rect', 'ellipse']).optional().describe('Shape primitive. Defaults to "rect".'),
        title: z.string().optional().describe('Node title (used in the layers panel). Defaults to "Shape".'),
        x: z.number().optional().describe('X position (canvas coords). Auto-placed if omitted.'),
        y: z.number().optional().describe('Y position (canvas coords). Auto-placed if omitted.'),
        width: z.number().optional().describe('Width in canvas-px. Default 200.'),
        height: z.number().optional().describe('Height in canvas-px. Default 140.'),
        fill: z.string().optional().describe('Fill color (hex or "transparent"). Default "#E8EEF7".'),
        stroke: z.string().optional().describe('Stroke color (hex or "transparent"). Default "#5B7CBF".'),
        strokeWidth: z.number().optional().describe('Stroke width in px. Default 2. Set 0 for no stroke.'),
        text: z.string().optional().describe('Optional label rendered centered inside the shape.'),
        textColor: z.string().optional().describe('Text color (hex). Defaults to the stroke color when present.'),
        fontSize: z.number().optional().describe('Text font size in px. Default 16.'),
      }),
      execute: async (input) => {
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        const kind = (input.kind as 'rect' | 'ellipse' | undefined) ?? 'rect';
        const title = (input.title as string) ?? DEFAULT_DIMENSIONS.shape.title;
        const width = (input.width as number | undefined) ?? DEFAULT_DIMENSIONS.shape.width;
        const height = (input.height as number | undefined) ?? DEFAULT_DIMENSIONS.shape.height;

        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const pos = (input.x != null && input.y != null)
          ? { x: input.x as number, y: input.y as number }
          : autoPlace(canvas.nodes);

        const newNode: CanvasNode = {
          id: nodeId,
          type: 'shape',
          title,
          x: pos.x,
          y: pos.y,
          width,
          height,
          data: {
            kind,
            fill: (input.fill as string | undefined) ?? '#E8EEF7',
            stroke: (input.stroke as string | undefined) ?? '#5B7CBF',
            strokeWidth: (input.strokeWidth as number | undefined) ?? 2,
            text: (input.text as string | undefined) ?? '',
            textColor: input.textColor as string | undefined,
            fontSize: input.fontSize as number | undefined,
          },
          updatedAt: Date.now(),
        };

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.nodes.push(newNode);
        await saveCanvas(workspaceId, fresh);
        broadcastUpdate(workspaceId, [nodeId]);

        return JSON.stringify({ ok: true, nodeId, kind, title });
      },
    },

    // ─── Edges (connections between nodes) ──────────────────────────

    canvas_list_edges: {
      name: 'canvas_list_edges',
      description:
        'List every edge (connection / arrow) on the canvas with resolved endpoint titles. ' +
        'Useful when you need to understand what the user has linked together — e.g. to figure out ' +
        'which file node backs an agent node, or to find nodes that reference each other. ' +
        'Defaults to the current workspace; pass `workspaceId` to inspect another canvas the user @-mentioned.',
      inputSchema: z.object({
        workspaceId: z.string().optional().describe('Target workspace ID. Defaults to the current workspace.'),
      }),
      execute: async (input) => {
        const targetWorkspaceId = (input.workspaceId as string) || workspaceId;
        const canvas = await loadCanvas(targetWorkspaceId);
        if (!canvas) return `Error: workspace not found: ${targetWorkspaceId}`;
        const edges = canvas.edges ?? [];
        if (edges.length === 0) return 'No edges on this canvas.';
        const nodesById = new Map(canvas.nodes.map((n) => [n.id, n]));
        return JSON.stringify(
          edges.map((e) => ({
            id: e.id,
            source: describeEndpoint(e.source, nodesById),
            target: describeEndpoint(e.target, nodesById),
            label: e.label,
            kind: e.kind,
            arrowHead: e.arrowHead ?? 'triangle',
            arrowTail: e.arrowTail ?? 'none',
            stroke: e.stroke,
            bend: e.bend ?? 0,
          })),
          null,
          2,
        );
      },
    },

    canvas_create_edge: {
      name: 'canvas_create_edge',
      description:
        'Connect two nodes (or free points) on the canvas with an arrow. ' +
        'Endpoints are node-bound by default: pass `sourceNodeId` / `targetNodeId`. For a free-floating ' +
        'endpoint (not attached to any node) pass `sourceX`/`sourceY` or `targetX`/`targetY` in canvas coords instead. ' +
        'Use `label` to annotate the connection with text the user will see. ' +
        'Use `kind` and `payload` to tag the edge with semantic info other tools can read later ' +
        '(e.g. `kind: "depends-on"`, `payload: { reason: "uses the PRD" }`).',
      inputSchema: z.object({
        sourceNodeId: z.string().optional().describe('Source node ID (node-bound endpoint).'),
        sourceAnchor: z.enum(['top', 'right', 'bottom', 'left', 'auto']).optional()
          .describe('Which side of the source node to anchor to. Default: "auto" (edge-hugging).'),
        sourceX: z.number().optional().describe('Free-point source X (canvas coords). Used if sourceNodeId is omitted.'),
        sourceY: z.number().optional().describe('Free-point source Y (canvas coords). Used if sourceNodeId is omitted.'),
        targetNodeId: z.string().optional().describe('Target node ID (node-bound endpoint).'),
        targetAnchor: z.enum(['top', 'right', 'bottom', 'left', 'auto']).optional()
          .describe('Which side of the target node to anchor to. Default: "auto".'),
        targetX: z.number().optional().describe('Free-point target X (canvas coords).'),
        targetY: z.number().optional().describe('Free-point target Y (canvas coords).'),
        label: z.string().optional().describe('Optional short label displayed on the edge.'),
        arrowHead: z.enum(['none', 'triangle', 'arrow', 'dot', 'bar']).optional()
          .describe('Cap rendered at the target end. Default: "triangle".'),
        arrowTail: z.enum(['none', 'triangle', 'arrow', 'dot', 'bar']).optional()
          .describe('Cap rendered at the source end. Default: "none".'),
        color: z.string().optional().describe('Stroke color (hex, e.g. "#1f2328").'),
        width: z.number().optional().describe('Stroke width in px. Default 2.4.'),
        style: z.enum(['solid', 'dashed', 'dotted']).optional().describe('Stroke dash style. Default "solid".'),
        bend: z.number().optional().describe('Perpendicular peak offset of the curve. 0 (default) = straight line.'),
        kind: z.string().optional().describe('Optional semantic tag (e.g. "depends-on", "references").'),
        payload: z.record(z.string(), z.unknown()).optional().describe('Free-form extra data attached to the edge.'),
      }),
      execute: async (input) => {
        let source: EdgeEndpoint;
        let target: EdgeEndpoint;
        try {
          source = buildEndpoint({
            nodeId: input.sourceNodeId as string | undefined,
            anchor: input.sourceAnchor as string | undefined,
            x: input.sourceX as number | undefined,
            y: input.sourceY as number | undefined,
            which: 'source',
          });
          target = buildEndpoint({
            nodeId: input.targetNodeId as string | undefined,
            anchor: input.targetAnchor as string | undefined,
            x: input.targetX as number | undefined,
            y: input.targetY as number | undefined,
            which: 'target',
          });
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';

        // Validate referenced nodes exist before committing — otherwise the
        // agent could create a zombie edge pointing at a deleted node id.
        if (source.kind === 'node' && !canvas.nodes.some((n) => n.id === source.nodeId)) {
          return `Error: source node not found: ${source.nodeId}`;
        }
        if (target.kind === 'node' && !canvas.nodes.some((n) => n.id === target.nodeId)) {
          return `Error: target node not found: ${target.nodeId}`;
        }

        const stroke: EdgeStroke | undefined =
          input.color != null || input.width != null || input.style != null
            ? {
                color: (input.color as string | undefined) ?? '#1f2328',
                width: (input.width as number | undefined) ?? 2.4,
                style: (input.style as 'solid' | 'dashed' | 'dotted' | undefined) ?? 'solid',
              }
            : undefined;

        const edge: CanvasEdge = {
          id: genEdgeId(),
          source,
          target,
          bend: (input.bend as number | undefined) ?? 0,
          arrowHead: (input.arrowHead as EdgeArrowCap | undefined) ?? 'triangle',
          arrowTail: (input.arrowTail as EdgeArrowCap | undefined) ?? 'none',
          stroke,
          label: input.label as string | undefined,
          kind: input.kind as string | undefined,
          payload: input.payload as Record<string, unknown> | undefined,
          updatedAt: Date.now(),
        };

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.edges = [...(fresh.edges ?? []), edge];
        await saveCanvas(workspaceId, fresh);

        // Broadcast using the endpoint node IDs so the renderer highlights
        // them as "recently changed". Edges with two free-point endpoints
        // still trigger a reload via any existing node id on the canvas;
        // if none exist we skip — the renderer only re-reads when at least
        // one node id is supplied, which is fine for a canvas with zero nodes.
        const touchedIds = [source, target]
          .filter((ep): ep is Extract<EdgeEndpoint, { kind: 'node' }> => ep.kind === 'node')
          .map((ep) => ep.nodeId);
        if (touchedIds.length === 0 && fresh.nodes.length > 0) {
          // Two free-point endpoints — nudge the renderer by referencing any
          // node so it re-reads edges from disk.
          touchedIds.push(fresh.nodes[0].id);
        }
        if (touchedIds.length > 0) broadcastUpdate(workspaceId, touchedIds);

        return JSON.stringify({ ok: true, edgeId: edge.id });
      },
    },

    canvas_update_edge: {
      name: 'canvas_update_edge',
      description:
        'Update fields on an existing edge. Supports changing label, kind, payload, arrow caps, stroke, and bend. ' +
        'Endpoint mutation is intentionally not supported — delete the edge and create a new one instead to keep the ' +
        'semantics obvious in the undo history.',
      inputSchema: z.object({
        edgeId: z.string().describe('The ID of the edge to update.'),
        label: z.string().optional(),
        kind: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        arrowHead: z.enum(['none', 'triangle', 'arrow', 'dot', 'bar']).optional(),
        arrowTail: z.enum(['none', 'triangle', 'arrow', 'dot', 'bar']).optional(),
        color: z.string().optional(),
        width: z.number().optional(),
        style: z.enum(['solid', 'dashed', 'dotted']).optional(),
        bend: z.number().optional(),
      }),
      execute: async (input) => {
        const edgeId = input.edgeId as string;

        // Single read against the latest disk state. Building `next` from
        // a stale copy and splicing it into a freshly-read canvas would
        // silently overwrite any concurrent writer's changes to other
        // fields of the same edge; falling back to `push(next)` when the
        // edge was deleted between the two reads would also resurrect a
        // just-deleted edge. Read once, derive `next` from the live
        // version, and bail if the edge is gone.
        const fresh = await loadCanvas(workspaceId);
        if (!fresh) return 'Error: workspace not found';
        const freshEdges = [...(fresh.edges ?? [])];
        const freshIdx = freshEdges.findIndex((e) => e.id === edgeId);
        if (freshIdx === -1) return `Error: edge not found: ${edgeId}`;
        const existing = freshEdges[freshIdx];

        const nextStroke =
          input.color != null || input.width != null || input.style != null
            ? {
                color: (input.color as string | undefined) ?? existing.stroke?.color ?? '#1f2328',
                width: (input.width as number | undefined) ?? existing.stroke?.width ?? 2.4,
                style:
                  (input.style as 'solid' | 'dashed' | 'dotted' | undefined) ??
                  existing.stroke?.style ??
                  'solid',
              }
            : existing.stroke;
        const next: CanvasEdge = {
          ...existing,
          label: input.label !== undefined ? (input.label as string) : existing.label,
          kind: input.kind !== undefined ? (input.kind as string) : existing.kind,
          payload:
            input.payload !== undefined
              ? (input.payload as Record<string, unknown>)
              : existing.payload,
          arrowHead: (input.arrowHead as EdgeArrowCap | undefined) ?? existing.arrowHead,
          arrowTail: (input.arrowTail as EdgeArrowCap | undefined) ?? existing.arrowTail,
          stroke: nextStroke,
          bend: input.bend != null ? (input.bend as number) : existing.bend,
          updatedAt: Date.now(),
        };

        freshEdges[freshIdx] = next;
        fresh.edges = freshEdges;
        await saveCanvas(workspaceId, fresh);

        const touchedIds = [next.source, next.target]
          .filter((ep): ep is Extract<EdgeEndpoint, { kind: 'node' }> => ep.kind === 'node')
          .map((ep) => ep.nodeId);
        if (touchedIds.length === 0 && fresh.nodes.length > 0) {
          touchedIds.push(fresh.nodes[0].id);
        }
        if (touchedIds.length > 0) broadcastUpdate(workspaceId, touchedIds);

        return JSON.stringify({ ok: true, edgeId });
      },
    },

    canvas_delete_edge: {
      name: 'canvas_delete_edge',
      description: 'Delete an edge by id.',
      inputSchema: z.object({
        edgeId: z.string().describe('The ID of the edge to delete.'),
      }),
      execute: async (input) => {
        const edgeId = input.edgeId as string;
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) return 'Error: workspace not found';
        const existing = (canvas.edges ?? []).find((e) => e.id === edgeId);
        if (!existing) return `Error: edge not found: ${edgeId}`;

        const fresh = (await loadCanvas(workspaceId)) ?? canvas;
        fresh.edges = (fresh.edges ?? []).filter((e) => e.id !== edgeId);
        await saveCanvas(workspaceId, fresh);

        const touchedIds = [existing.source, existing.target]
          .filter((ep): ep is Extract<EdgeEndpoint, { kind: 'node' }> => ep.kind === 'node')
          .map((ep) => ep.nodeId);
        if (touchedIds.length === 0 && fresh.nodes.length > 0) {
          touchedIds.push(fresh.nodes[0].id);
        }
        if (touchedIds.length > 0) broadcastUpdate(workspaceId, touchedIds);

        return JSON.stringify({ ok: true, edgeId });
      },
    },
  };
}

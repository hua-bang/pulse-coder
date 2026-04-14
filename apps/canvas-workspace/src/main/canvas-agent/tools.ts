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

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

// ─── Types mirrored from canvas-cli ────────────────────────────────

type NodeType = 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe';

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
  text: { title: 'Text', width: 260, height: 120 },
  iframe: { title: 'Web', width: 520, height: 400 },
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
    try {
      const raw = await fs.readFile(canvasPath(workspaceId), 'utf-8');
      const existing = JSON.parse(raw) as CanvasSaveData;
      const existingNodes = Array.isArray(existing.nodes) ? existing.nodes : [];
      if (existingNodes.length > 0) {
        throw new Error(
          `[canvas-agent] refusing to overwrite ${existingNodes.length} on-disk nodes ` +
          `with empty nodes for workspace "${workspaceId}". ` +
          `Pass { allowEmpty: true } to saveCanvas if this wipe is intentional.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('[canvas-agent] refusing')) {
        throw err;
      }
      // File missing or unparseable — nothing to protect.
    }
  }

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
        '- **iframe**: Embeds an external web page on the canvas. Pass `data.url` with the full URL (including protocol). ' +
        'Note: some sites block embedding via X-Frame-Options / CSP.',
      inputSchema: z.object({
        type: z.enum(['file', 'terminal', 'frame', 'agent', 'text', 'iframe']).describe('Node type.'),
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
          '- iframe: { url: string }',
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
          case 'iframe':
            nodeData = {
              url: (extraData.url as string) ?? '',
            };
            break;
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
  };
}

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execInSession, hasSession } from './pty-manager';

export const MCP_PORT = 3333;

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

// --- Types ---

type NodeType = 'file' | 'terminal' | 'frame';
type NodeCapability = 'read' | 'write' | 'exec';

interface CanvasNodeData {
  filePath?: string;
  content?: string;
  scrollback?: string;
  cwd?: string;
  color?: string;
  label?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface CanvasNode {
  id: string;
  type: NodeType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: CanvasNodeData;
}

interface CanvasSaveData {
  nodes: CanvasNode[];
  transform: unknown;
  savedAt: string;
}

interface WorkspaceEntry {
  id: string;
  name: string;
}

interface WorkspaceManifest {
  entries: WorkspaceEntry[];
}

// --- Node capability mapping ---

const NODE_CAPABILITIES: Record<NodeType, NodeCapability[]> = {
  file: ['read', 'write'],
  terminal: ['read', 'exec'],
  frame: ['read', 'write'],
};

function getNodeCapabilities(type: NodeType): NodeCapability[] {
  return NODE_CAPABILITIES[type] ?? ['read'];
}

// --- Canvas data access ---

async function loadCanvas(workspaceId: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, workspaceId, 'canvas.json'), 'utf-8');
    return JSON.parse(raw) as CanvasSaveData;
  } catch {
    return null;
  }
}

async function saveCanvas(workspaceId: string, data: CanvasSaveData): Promise<void> {
  await fs.writeFile(
    join(STORE_DIR, workspaceId, 'canvas.json'),
    JSON.stringify(data, null, 2),
    'utf-8'
  );
}

async function loadWorkspaceManifest(): Promise<WorkspaceManifest> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, '__workspaces__.json'), 'utf-8');
    return JSON.parse(raw) as WorkspaceManifest;
  } catch {
    return { entries: [] };
  }
}

async function listWorkspaceIds(): Promise<string[]> {
  try {
    await fs.mkdir(STORE_DIR, { recursive: true });
    const entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
    return entries
      .filter((e: import('fs').Dirent) => e.isDirectory() && e.name !== '__workspaces__')
      .map((e: import('fs').Dirent) => e.name);
  } catch {
    return [];
  }
}

// --- Node IO providers ---

interface NodeReadResult {
  type: NodeType;
  capabilities: NodeCapability[];
  [key: string]: unknown;
}

async function readNode(node: CanvasNode): Promise<NodeReadResult> {
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

async function writeNode(
  workspaceId: string,
  nodeId: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  const canvas = await loadCanvas(workspaceId);
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
      await saveCanvas(workspaceId, canvas);
      return { ok: true };
    }
    case 'frame': {
      try {
        const patch = JSON.parse(content) as { label?: string; color?: string };
        if (patch.label !== undefined) node.data.label = patch.label;
        if (patch.color !== undefined) node.data.color = patch.color;
        canvas.savedAt = new Date().toISOString();
        await saveCanvas(workspaceId, canvas);
        return { ok: true };
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

// --- MCP tool definitions ---

const TOOLS = [
  {
    name: 'canvas_list',
    description:
      'List all nodes in the canvas workspace. Returns node IDs, types, titles, capabilities (read/write/exec), and which workspace they belong to.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Optional: restrict to a specific workspace ID'
        }
      }
    }
  },
  {
    name: 'canvas_read',
    description:
      'Read a canvas node. Returns structured JSON with type, capabilities, and content. File nodes include path/content/language. Terminal nodes include cwd/scrollback. Frame nodes include label/color.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        nodeId: { type: 'string', description: 'Node ID to read' }
      },
      required: ['workspaceId', 'nodeId']
    }
  },
  {
    name: 'canvas_write',
    description:
      'Write content to a content-type canvas node. File nodes accept markdown/code text. Frame nodes accept JSON: { label?: string, color?: string }. Use canvas_exec for terminal nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        nodeId: { type: 'string', description: 'Node ID to write to' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['workspaceId', 'nodeId', 'content']
    }
  },
  {
    name: 'canvas_exec',
    description:
      'Execute a command in an interactive-type canvas node (terminal). Sends the command to the PTY session and returns the output.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        nodeId: { type: 'string', description: 'Terminal node ID to execute in' },
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' }
      },
      required: ['workspaceId', 'nodeId', 'command']
    }
  },
  {
    name: 'canvas_create',
    description:
      'Create a new canvas node. Returns the created node ID. Supported types: file, terminal, frame.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        type: { type: 'string', enum: ['file', 'terminal', 'frame'], description: 'Node type to create' },
        title: { type: 'string', description: 'Node title (optional, has defaults per type)' },
        x: { type: 'number', description: 'X position on canvas (optional, auto-placed if omitted)' },
        y: { type: 'number', description: 'Y position on canvas (optional, auto-placed if omitted)' },
        data: {
          type: 'object',
          description: 'Initial data. File: { content?: string }. Frame: { color?: string, label?: string }. Terminal: { cwd?: string }.'
        }
      },
      required: ['workspaceId', 'type']
    }
  }
];

// --- Helpers ---

function autoPlaceX(nodes: Array<{ x?: number; width?: number }>): number {
  if (nodes.length === 0) return 100;
  let maxRight = 0;
  for (const n of nodes) {
    const right = (n.x ?? 0) + (n.width ?? 400);
    if (right > maxRight) maxRight = right;
  }
  return maxRight + 40; // 40px gap
}

// --- MCP tool dispatch ---

type ToolArgs = Record<string, string | undefined>;

async function handleToolCall(
  name: string,
  args: ToolArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let text: string;

  try {
    switch (name) {
      case 'canvas_list': {
        const ids = args.workspaceId ? [args.workspaceId] : await listWorkspaceIds();
        const manifest = await loadWorkspaceManifest();
        const nameMap = new Map(manifest.entries.map(e => [e.id, e.name]));

        const rows: Array<{
          workspaceId: string;
          workspaceName: string;
          nodeId: string;
          type: string;
          title: string;
          capabilities: NodeCapability[];
        }> = [];

        for (const wsId of ids) {
          const canvas = await loadCanvas(wsId);
          if (!canvas) continue;
          for (const node of canvas.nodes) {
            rows.push({
              workspaceId: wsId,
              workspaceName: nameMap.get(wsId) ?? wsId,
              nodeId: node.id,
              type: node.type,
              title: node.title,
              capabilities: getNodeCapabilities(node.type),
            });
          }
        }

        text = JSON.stringify(rows, null, 2);
        break;
      }

      case 'canvas_read': {
        const { workspaceId, nodeId } = args;
        if (!workspaceId || !nodeId) {
          text = 'Error: workspaceId and nodeId are required';
          break;
        }
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) { text = `Error: workspace not found: ${workspaceId}`; break; }
        const node = canvas.nodes.find(n => n.id === nodeId);
        if (!node) { text = `Error: node not found: ${nodeId}`; break; }
        const result = await readNode(node);
        text = JSON.stringify(result, null, 2);
        break;
      }

      case 'canvas_write': {
        const { workspaceId, nodeId, content } = args;
        if (!workspaceId || !nodeId || content === undefined) {
          text = 'Error: workspaceId, nodeId, and content are required';
          break;
        }
        const writeResult = await writeNode(workspaceId, nodeId, content);
        text = writeResult.ok ? 'OK' : `Error: ${writeResult.error}`;
        break;
      }

      case 'canvas_exec': {
        const { workspaceId, nodeId, command } = args;
        if (!workspaceId || !nodeId || !command) {
          text = 'Error: workspaceId, nodeId, and command are required';
          break;
        }
        const canvas = await loadCanvas(workspaceId);
        if (!canvas) { text = `Error: workspace not found: ${workspaceId}`; break; }
        const node = canvas.nodes.find(n => n.id === nodeId);
        if (!node) { text = `Error: node not found: ${nodeId}`; break; }
        if (node.type !== 'terminal') {
          text = `Error: canvas_exec only works on terminal nodes, got "${node.type}". Use canvas_write for content nodes.`;
          break;
        }

        const sessionId = node.data.sessionId;
        if (!sessionId || !hasSession(sessionId)) {
          text = 'Error: terminal node has no active PTY session. The terminal must be open in the canvas UI first.';
          break;
        }

        const timeoutMs = args.timeout ? Number(args.timeout) : undefined;
        const execResult = await execInSession(sessionId, command, { timeout: timeoutMs });
        if (execResult.ok) {
          text = execResult.output ?? '';
        } else {
          text = `Error: ${execResult.error}`;
        }
        break;
      }

      case 'canvas_create': {
        const { workspaceId } = args;
        const nodeType = args.type as NodeType | undefined;
        if (!workspaceId || !nodeType) {
          text = 'Error: workspaceId and type are required';
          break;
        }
        if (!['file', 'terminal', 'frame'].includes(nodeType)) {
          text = `Error: unsupported node type "${nodeType}". Supported: file, terminal, frame.`;
          break;
        }

        const canvas = await loadCanvas(workspaceId);
        if (!canvas) { text = `Error: workspace not found: ${workspaceId}`; break; }

        // Generate node ID
        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Default dimensions per type
        const defaults: Record<NodeType, { title: string; width: number; height: number }> = {
          file:     { title: 'Untitled', width: 420, height: 360 },
          terminal: { title: 'Terminal', width: 480, height: 300 },
          frame:    { title: 'Frame',    width: 600, height: 400 },
        };
        const def = defaults[nodeType];

        // Auto-place: find the rightmost node and place to its right, or use provided position
        const x = args.x !== undefined ? Number(args.x) : autoPlaceX(canvas.nodes);
        const y = args.y !== undefined ? Number(args.y) : 100;

        // Build initial data
        const inputData = args.data ? (typeof args.data === 'string' ? JSON.parse(args.data) : args.data) : {};
        let data: CanvasNodeData;
        switch (nodeType) {
          case 'file':
            data = { filePath: '', content: (inputData as Record<string, string>).content ?? '', saved: false, modified: false };
            break;
          case 'terminal':
            data = { sessionId: '', cwd: (inputData as Record<string, string>).cwd ?? '' };
            break;
          case 'frame':
            data = { color: (inputData as Record<string, string>).color ?? '#9575d4', label: (inputData as Record<string, string>).label ?? '' };
            break;
        }

        const newNode: CanvasNode & { x: number; y: number; width: number; height: number } = {
          id: nodeId,
          type: nodeType,
          title: args.title ?? def.title,
          x,
          y,
          width: def.width,
          height: def.height,
          data,
        };

        canvas.nodes.push(newNode as unknown as CanvasNode);
        canvas.savedAt = new Date().toISOString();
        await saveCanvas(workspaceId, canvas);

        // If file node, create a workspace note file
        if (nodeType === 'file' && data.content) {
          const notesDir = join(STORE_DIR, workspaceId, 'notes');
          await fs.mkdir(notesDir, { recursive: true });
          const noteFile = join(notesDir, `${nodeId}.md`);
          await fs.writeFile(noteFile, data.content, 'utf-8');
          data.filePath = noteFile;
          canvas.savedAt = new Date().toISOString();
          await saveCanvas(workspaceId, canvas);
        }

        text = JSON.stringify({
          ok: true,
          nodeId,
          type: nodeType,
          title: newNode.title,
          capabilities: getNodeCapabilities(nodeType),
        }, null, 2);
        break;
      }

      default:
        text = `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    text = `Error: ${String(err)}`;
  }

  return { content: [{ type: 'text', text }] };
}

// --- JSON-RPC / MCP request handler ---

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

async function handleMCPRequest(body: string): Promise<unknown> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(body) as JsonRpcRequest;
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }

  const { id, method, params } = req;

  // JSON-RPC notifications have no id and need no response
  if (id === undefined) return null;

  try {
    switch (method) {
      case 'initialize': {
        // Negotiate protocol version: accept what the client requests if we support it,
        // otherwise respond with our latest supported version.
        const SUPPORTED_VERSIONS = ['2025-03-26', '2024-11-05'];
        const clientVersion = (params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(clientVersion)
          ? clientVersion
          : '2025-03-26';
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'canvas-workspace', version: '0.1.0' }
          }
        };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const p = params as { name: string; arguments?: ToolArgs };
        const result = await handleToolCall(p.name, p.arguments ?? {});
        return { jsonrpc: '2.0', id, result };
      }

      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } };
  }
}

// --- HTTP server ---

export function startMCPServer(): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'canvas-workspace-mcp' }));
      return;
    }

    if (req.url === '/mcp' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: unknown) => { body += String(chunk); });
      req.on('end', () => {
        void (async () => {
          const response = await handleMCPRequest(body);
          if (response === null) {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[MCP] Canvas workspace server on localhost:${MCP_PORT}`);
  });

  server.on('error', (err: Error & { code?: string }) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[MCP] Port ${MCP_PORT} in use — server not started`);
    } else {
      console.error('[MCP] Server error:', err);
    }
  });
}

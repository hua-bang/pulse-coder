import { createServer, IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const MCP_PORT = 3333;

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

// --- Types ---

interface CanvasNodeData {
  filePath?: string;
  content?: string;
  scrollback?: string;
  cwd?: string;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

interface CanvasNode {
  id: string;
  type: 'file' | 'terminal' | 'frame';
  title: string;
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

// --- Node providers ---

async function readNode(node: CanvasNode): Promise<string> {
  switch (node.type) {
    case 'file': {
      if (node.data.filePath) {
        try {
          return await fs.readFile(node.data.filePath, 'utf-8');
        } catch {
          // fall through to in-memory content
        }
      }
      return node.data.content ?? '';
    }
    case 'terminal':
      return node.data.scrollback ?? '';
    case 'frame':
      return JSON.stringify({ label: node.data.label ?? '', color: node.data.color ?? '' });
    default:
      return '';
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
      return { ok: false, error: 'Terminal nodes are read-only via MCP' };
    default:
      return { ok: false, error: 'Unknown node type' };
  }
}

// --- MCP tool definitions ---

const TOOLS = [
  {
    name: 'canvas_list',
    description:
      'List all nodes in the canvas workspace. Returns node IDs, types, titles, and which workspace they belong to.',
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
      'Read the content of a canvas node. File nodes return markdown content, terminal nodes return scrollback buffer, frame nodes return JSON with label and color.',
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
      'Write content to a canvas node. File nodes accept markdown text. Frame nodes accept JSON: { label?: string, color?: string }. Terminal nodes are read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace ID' },
        nodeId: { type: 'string', description: 'Node ID to write to' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['workspaceId', 'nodeId', 'content']
    }
  }
];

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
              title: node.title
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
        text = await readNode(node);
        break;
      }

      case 'canvas_write': {
        const { workspaceId, nodeId, content } = args;
        if (!workspaceId || !nodeId || content === undefined) {
          text = 'Error: workspaceId, nodeId, and content are required';
          break;
        }
        const result = await writeNode(workspaceId, nodeId, content);
        text = result.ok ? 'OK' : `Error: ${result.error}`;
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

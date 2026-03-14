/**
 * Minimal JSON-RPC 2.0 over stdio client for ACP (Agent Client Protocol).
 *
 * Protocol reference: https://agentclientprotocol.com
 *
 * Transport: newline-delimited JSON over stdin/stdout.
 * The server may send:
 *   - Responses     { jsonrpc, id, result }  or  { jsonrpc, id, error }
 *   - Notifications { jsonrpc, method, params }               (no id)
 *   - Requests      { jsonrpc, id, method, params }           (server→client, e.g. session/request_permission, fs/*)
 */
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { promises as fsPromises } from 'fs';
import * as nodePath from 'path';
import type { AcpAgent } from './state.js';

const ACP_DEBUG = process.env.ACP_DEBUG === '1' || process.env.ACP_DEBUG === 'true';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface RpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

interface RpcError {
  jsonrpc: '2.0';
  id: string;
  error: { code: number; message: string; data?: unknown };
}

type RpcResponse = RpcSuccess | RpcError;
type RpcIncoming = RpcResponse | RpcNotification | RpcRequest;

// ---------------------------------------------------------------------------
// ACP-specific types
// ---------------------------------------------------------------------------

export interface SessionUpdateNotification {
  sessionId: string;
  update: {
    sessionUpdate: 'plan' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update';
    /** text chunk (agent_message_chunk) */
    content?: { type: string; text: string };
    /** tool call info */
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    entries?: unknown[];
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    [key: string]: unknown;
  };
  agentInfo: { name: string; title?: string; version?: string };
}

export interface SessionNewResult {
  sessionId: string;
}

export interface PromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Spawn command resolution
// ---------------------------------------------------------------------------

const DEFAULT_CMDS: Record<AcpAgent, string> = {
  claude: 'claude-agent-acp',
  codex: 'codex-acp',   // @zed-industries/codex-acp installs as 'codex-acp'
};

function resolveCmd(agent: AcpAgent): string {
  const envKey = agent === 'claude' ? 'ACP_CLAUDE_CODE_CMD' : 'ACP_CODEX_CMD';
  return process.env[envKey]?.trim() || DEFAULT_CMDS[agent];
}

// ---------------------------------------------------------------------------
// AcpClient
// ---------------------------------------------------------------------------

type PendingEntry = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type NotificationHandler = (method: string, params: unknown) => void;

export class AcpClient {
  private proc: ChildProcess;
  private pending = new Map<string, PendingEntry>();
  private notificationHandlers: NotificationHandler[] = [];
  private closed = false;
  private cwd: string;
  private agent: AcpAgent;

  constructor(agent: AcpAgent, cwd: string) {
    this.agent = agent;
    this.cwd = cwd;

    const cmd = resolveCmd(agent);
    const [bin, ...args] = cmd.split(/\s+/);
    this.proc = spawn(bin!, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    // read stderr for debug logging
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[acp/${agent}] ${chunk.toString().trim()}`);
    });

    // line-buffered stdout parsing
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as RpcIncoming;
        if (ACP_DEBUG) {
          console.error(`[acp/${agent}] ← ${trimmed}`);
        }
        this.dispatch(msg);
      } catch {
        console.error('[acp/client] failed to parse line:', trimmed);
      }
    });

    this.proc.on('close', (code) => {
      this.closed = true;
      const err = new Error(`ACP server exited with code ${code}`);
      for (const entry of this.pending.values()) {
        entry.reject(err);
      }
      this.pending.clear();
    });
  }

  // -------------------------------------------------------------------------
  // Internal dispatch
  // -------------------------------------------------------------------------

  private dispatch(msg: RpcIncoming): void {
    // Server-to-client requests (have both id and method)
    if ('id' in msg && 'method' in msg) {
      this.handleServerRequest(msg as RpcRequest).catch((err) => {
        console.error(`[acp/${this.agent}] handleServerRequest error:`, err);
      });
      return;
    }

    // Responses (have id, no method)
    if ('id' in msg && !('method' in msg)) {
      const entry = this.pending.get((msg as RpcResponse).id);
      if (!entry) return;
      this.pending.delete((msg as RpcResponse).id);
      const response = msg as RpcResponse;
      if ('error' in response) {
        entry.reject(new Error(`ACP error ${response.error.code}: ${response.error.message}`));
      } else {
        entry.resolve((response as RpcSuccess).result);
      }
      return;
    }

    // Notifications (have method, no id)
    if ('method' in msg && !('id' in msg)) {
      const notif = msg as RpcNotification;
      for (const handler of this.notificationHandlers) {
        handler(notif.method, notif.params);
      }
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    // Auto-approve all permission requests
    if (req.method === 'session/request_permission') {
      this.send({ jsonrpc: '2.0', id: req.id, result: { approved: true } });
      return;
    }

    // File system capabilities — agents use these to read/write files on the client
    if (req.method === 'fs/read_text_file') {
      const params = req.params as { path: string };
      try {
        const absPath = nodePath.isAbsolute(params.path)
          ? params.path
          : nodePath.resolve(this.cwd, params.path);
        const content = await fsPromises.readFile(absPath, 'utf8');
        this.send({ jsonrpc: '2.0', id: req.id, result: { content } });
      } catch (err) {
        this.send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err) } });
      }
      return;
    }

    if (req.method === 'fs/write_text_file') {
      const params = req.params as { path: string; content: string };
      try {
        const absPath = nodePath.isAbsolute(params.path)
          ? params.path
          : nodePath.resolve(this.cwd, params.path);
        await fsPromises.mkdir(nodePath.dirname(absPath), { recursive: true });
        await fsPromises.writeFile(absPath, params.content, 'utf8');
        this.send({ jsonrpc: '2.0', id: req.id, result: {} });
      } catch (err) {
        this.send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err) } });
      }
      return;
    }

    // Unknown server request → method-not-found
    console.warn(`[acp/${this.agent}] unhandled server request: ${req.method}`);
    this.send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error('ACP client is closed');
    const id = randomUUID();
    if (ACP_DEBUG) {
      console.error(`[acp/${this.agent}] → ${JSON.stringify({ method, params })}`);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Register a handler for incoming notifications. Returns an unsubscribe fn. */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  kill(): void {
    if (!this.closed) {
      this.proc.kill();
    }
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    this.proc.stdin?.write(JSON.stringify(msg) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

export function createAcpClient(agent: AcpAgent, cwd: string): AcpClient {
  return new AcpClient(agent, cwd);
}

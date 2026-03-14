import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { promises as fsPromises } from 'fs';
import * as nodePath from 'path';
import type {
  AcpAgent,
  AcpClientOptions,
  PermissionOutcome,
  PermissionRequest,
  PermissionRequestHandler,
  PermissionOption,
} from './types.js';

const ACP_DEBUG = process.env.ACP_DEBUG === '1' || process.env.ACP_DEBUG === 'true';

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

const DEFAULT_CMDS: Record<AcpAgent, string> = {
  claude: 'claude-agent-acp',
  codex: 'codex-acp',
};

function resolveCmd(agent: AcpAgent, overrides?: Partial<Record<AcpAgent, string>>): string {
  if (overrides?.[agent]) {
    return overrides[agent]!.trim();
  }
  const envKey = agent === 'claude' ? 'ACP_CLAUDE_CODE_CMD' : 'ACP_CODEX_CMD';
  return process.env[envKey]?.trim() || DEFAULT_CMDS[agent];
}

type PendingEntry = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type NotificationHandler = (method: string, params: unknown) => void;

export class AcpClient {
  private proc: ChildProcess;
  private pending = new Map<string, PendingEntry>();
  private notificationHandlers: NotificationHandler[] = [];
  private closed = false;
  private cwd: string;
  private agent: AcpAgent;
  private permissionHandler?: PermissionRequestHandler;

  constructor(agent: AcpAgent, cwd: string, options?: AcpClientOptions) {
    this.agent = agent;
    this.cwd = cwd;
    this.permissionHandler = options?.onPermissionRequest;

    const cmd = resolveCmd(agent, options?.commandOverrides);
    const [bin, ...args] = cmd.split(/\s+/);
    this.proc = spawn(bin!, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[acp/${agent}] ${chunk.toString().trim()}`);
    });

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

  private dispatch(msg: RpcIncoming): void {
    if ('id' in msg && 'method' in msg) {
      this.handleServerRequest(msg as RpcRequest).catch((err) => {
        console.error(`[acp/${this.agent}] handleServerRequest error:`, err);
      });
      return;
    }

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

    if ('method' in msg && !('id' in msg)) {
      const notif = msg as RpcNotification;
      for (const handler of this.notificationHandlers) {
        handler(notif.method, notif.params);
      }
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    if (req.method === 'session/request_permission') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const options = normalizePermissionOptions(params.options);

      let outcome: PermissionOutcome | null = null;
      if (this.permissionHandler) {
        try {
          outcome = await this.permissionHandler({
            sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
            toolCall: isRecord(params.toolCall) ? params.toolCall : undefined,
            options,
            rawParams: params,
          } as PermissionRequest);
        } catch (err) {
          console.error(`[acp/${this.agent}] permission handler failed:`, err);
        }
      }

      const resolvedOutcome = outcome ?? chooseAutoPermissionOutcome(options);
      this.send({ jsonrpc: '2.0', id: req.id, result: { outcome: resolvedOutcome } });
      return;
    }

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

    console.warn(`[acp/${this.agent}] unhandled server request: ${req.method}`);
    this.send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error('ACP client is closed');
    const id = randomUUID();
    if (ACP_DEBUG) {
      console.error(`[acp/${this.agent}] → ${JSON.stringify({ jsonrpc: '2.0', id, method, params })}`);
    }
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.pending.set(id, entry);
    }) as Promise<T>;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.proc.kill();
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify(msg);
    if (ACP_DEBUG) {
      console.error(`[acp/${this.agent}] → ${payload}`);
    }
    this.proc.stdin?.write(`${payload}\n`);
  }
}

function normalizePermissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!isRecord(item) || !item.optionId) return null;
      return {
        optionId: String(item.optionId),
        kind: typeof item.kind === 'string' ? item.kind : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        ...item,
      } as PermissionOption;
    })
    .filter((item): item is PermissionOption => Boolean(item));
}

function chooseAutoPermissionOutcome(options: PermissionOption[]): PermissionOutcome {
  const approveOption = options.find((option) => {
    const kind = option.kind?.toLowerCase() ?? '';
    const optionId = option.optionId.toLowerCase();
    return kind === 'allow_once' || kind === 'allow_always' || optionId.includes('approv');
  });
  const selectedOption = approveOption ?? options[0];
  return selectedOption
    ? { outcome: 'selected', optionId: selectedOption.optionId }
    : { outcome: 'cancelled' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

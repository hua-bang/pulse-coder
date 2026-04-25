/**
 * mailbox-mcp: minimal stdio MCP server that exposes the team-tool surface
 * (mailbox + task list) to non-pulse agents (Claude Code, Codex, ...).
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 over stdio, per the
 * Model Context Protocol stdio transport.
 *
 * Spawned as a child process by `ClaudeCodeRuntime` / `CodexRuntime`.
 * Inputs are read from environment variables to keep the CLI argument list
 * stable across host configurations:
 *   - PULSE_TEAM_STATE_DIR    : team state directory (mailbox + tasks live here)
 *   - PULSE_TEAMMATE_ID       : id of the calling teammate
 *   - PULSE_REQUIRE_PLAN_APPROVAL : 'true' | 'false'
 */
import { Mailbox } from '../mailbox.js';
import { TaskList } from '../task-list.js';
import { TEAM_TOOL_SCHEMAS, callTeamTool } from '../team-tools.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2024-11-05';

export interface MailboxMcpServerOptions {
  stateDir: string;
  teammateId: string;
  requirePlanApproval?: boolean;
  /** Override the input stream (defaults to process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** Override the output stream (defaults to process.stdout). */
  stdout?: NodeJS.WritableStream;
}

/**
 * Dispatch a single parsed JSON-RPC request and return the response object,
 * or `null` if the request was a notification (no id).
 *
 * Exported so unit tests can exercise the protocol without spawning a process.
 */
export async function dispatchMailboxRpc(
  request: JsonRpcRequest,
  ctx: {
    teammateId: string;
    mailbox: Mailbox;
    taskList: TaskList;
    requirePlanApproval?: boolean;
  },
): Promise<JsonRpcResponse | null> {
  const visibleTools = TEAM_TOOL_SCHEMAS.filter(
    (t) => t.name !== 'team_submit_plan' || ctx.requirePlanApproval,
  );

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }

  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'pulse-mailbox-mcp', version: '0.1.0' },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          tools: visibleTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case 'tools/call': {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!params.name) {
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32602, message: 'Invalid params: missing tool name' },
        };
      }
      if (!visibleTools.some((t) => t.name === params.name)) {
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${params.name}` },
        };
      }
      try {
        const text = await callTeamTool(ctx, params.name, params.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      } catch (e) {
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: {
            content: [{ type: 'text', text: (e as Error).message }],
            isError: true,
          },
        };
      }
    }

    default:
      if (request.id !== undefined) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
      }
      return null;
  }
}

/**
 * Wire a server to the given streams. Resolves when input closes.
 * Exported so it can also be embedded in tests without spawning a child process.
 */
export function runMailboxMcpServer(opts: MailboxMcpServerOptions): Promise<void> {
  const mailbox = new Mailbox(opts.stateDir);
  const taskList = new TaskList(opts.stateDir);
  const ctx = {
    teammateId: opts.teammateId,
    mailbox,
    taskList,
    requirePlanApproval: opts.requirePlanApproval ?? false,
  };

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  if ('setEncoding' in stdin && typeof (stdin as any).setEncoding === 'function') {
    (stdin as any).setEncoding('utf-8');
  }

  const writeResponse = (msg: JsonRpcResponse): void => {
    stdout.write(JSON.stringify(msg) + '\n');
  };
  const writeInternalError = (
    id: JsonRpcRequest['id'] | null,
    message: string,
  ): void => {
    writeResponse({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32603, message },
    });
  };

  return new Promise((resolve) => {
    let buffer = '';

    stdin.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        handleLine(line).catch((e) => {
          writeInternalError(null, `Internal error: ${(e as Error).message}`);
        });
      }
    });
    stdin.on('end', () => resolve());
    stdin.on('close', () => resolve());

    async function handleLine(line: string): Promise<void> {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        writeResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      const res = await dispatchMailboxRpc(req, ctx);
      if (res) writeResponse(res);
    }
  });
}

/**
 * CLI entry — invoked by `claude --mcp-config` or `codex` mcp_servers entry.
 * Reads config from env so spawning code stays terse.
 */
export async function main(): Promise<void> {
  const stateDir = process.env.PULSE_TEAM_STATE_DIR;
  const teammateId = process.env.PULSE_TEAMMATE_ID;
  if (!stateDir || !teammateId) {
    process.stderr.write(
      'mailbox-mcp: PULSE_TEAM_STATE_DIR and PULSE_TEAMMATE_ID must be set\n',
    );
    process.exit(2);
  }
  await runMailboxMcpServer({
    stateDir,
    teammateId,
    requirePlanApproval: process.env.PULSE_REQUIRE_PLAN_APPROVAL === 'true',
  });
}

// Allow `node mailbox-mcp-server.js` to start the server.
const isDirect =
  // ESM: only invoke when this file is the entry point
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /mailbox-mcp-server\.[cm]?js$/.test(process.argv[1]);
if (isDirect) {
  main().catch((e) => {
    process.stderr.write(`mailbox-mcp fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

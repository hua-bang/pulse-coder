import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime, RuntimeContext, RuntimeRunOptions } from './types.js';

export interface ClaudeCodeRuntimeOptions {
  /** Path to the `claude` CLI. Defaults to `claude` (resolved via PATH). */
  cliPath?: string;
  /** Model override (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6'). */
  model?: string;
  /**
   * Absolute path to the mailbox-mcp server entry (Node JS file).
   * Defaults to the built `dist/mcp/mailbox-mcp-server.js` colocated with this module.
   */
  mcpServerEntry?: string;
  /**
   * Extra tools to allow beyond the mailbox MCP surface. Defaults to a safe
   * read/edit set; callers can broaden as needed.
   */
  allowedTools?: string[];
  /** Permission mode passed via `--permission-mode`. Defaults to 'acceptEdits'. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

interface StreamJsonLine {
  type: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  result?: string;
  subtype?: string;
  is_error?: boolean;
  [k: string]: unknown;
}

const DEFAULT_ALLOWED_TOOLS = [
  'mcp__mailbox__*',
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
];

/**
 * Drive Claude Code via its native CLI in headless stream-json mode.
 *
 * Each `run()` invocation spawns one `claude -p` process. After the first
 * turn we capture the `session_id` and reuse it via `--resume` so context
 * carries forward without re-feeding history.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = 'claude-code' as const;

  private mcpConfigPath?: string;
  private sessionId?: string;
  private active: ChildProcess | null = null;

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly options: ClaudeCodeRuntimeOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (!this.ctx.stateDir) {
      throw new Error(
        'ClaudeCodeRuntime requires RuntimeContext.stateDir to share mailbox/task state with the MCP server',
      );
    }
    // Stage the per-teammate MCP config file. The mailbox server reads its
    // identity from env vars set on spawn, so the same config can be reused
    // across turns.
    const runtimeDir = join(this.ctx.stateDir, 'runtime', this.ctx.teammateId);
    mkdirSync(runtimeDir, { recursive: true });

    const serverEntry = this.options.mcpServerEntry ?? this.defaultMcpServerEntry();

    const mcpConfig = {
      mcpServers: {
        mailbox: {
          command: process.execPath,
          args: [serverEntry],
          env: {
            PULSE_TEAM_STATE_DIR: this.ctx.stateDir!,
            PULSE_TEAMMATE_ID: this.ctx.teammateId,
            PULSE_REQUIRE_PLAN_APPROVAL: this.ctx.requirePlanApproval ? 'true' : 'false',
          },
        },
      },
    };
    this.mcpConfigPath = join(runtimeDir, 'mcp-config.json');
    writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  }

  async run(opts: RuntimeRunOptions): Promise<string> {
    if (!this.mcpConfigPath) {
      throw new Error('ClaudeCodeRuntime.run called before initialize()');
    }

    const cliPath = this.options.cliPath ?? 'claude';
    const allowed = (this.options.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(',');

    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose', // required when stream-json output is used
      '--append-system-prompt',
      opts.systemPrompt,
      '--mcp-config',
      this.mcpConfigPath,
      '--allowedTools',
      allowed,
      '--permission-mode',
      this.options.permissionMode ?? 'acceptEdits',
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    const proc = spawn(cliPath, args, {
      cwd: this.ctx.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = proc;

    const onAbort = () => {
      proc.kill('SIGTERM');
    };
    if (opts.abortSignal.aborted) onAbort();
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });

    let finalText = '';
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    try {
      for await (const line of readNdjson(proc.stdout!)) {
        const parsed = safeParse(line);
        if (!parsed) continue;
        finalText = this.handleStreamLine(parsed, opts, finalText);
      }
      const code: number | null = await new Promise((res) => {
        if (proc.exitCode !== null) res(proc.exitCode);
        else proc.once('close', (c) => res(c));
      });
      if (code !== 0 && !opts.abortSignal.aborted) {
        throw new Error(
          `claude CLI exited with code ${code}: ${stderr.trim() || '(no stderr)'}`,
        );
      }
      return finalText;
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
      this.active = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this.active) {
      this.active.kill('SIGTERM');
      this.active = null;
    }
  }

  private handleStreamLine(
    line: StreamJsonLine,
    opts: RuntimeRunOptions,
    acc: string,
  ): string {
    switch (line.type) {
      case 'system': {
        if (typeof line.session_id === 'string') this.sessionId = line.session_id;
        return acc;
      }
      case 'assistant': {
        const blocks = line.message?.content ?? [];
        let next = acc;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            next += block.text;
            opts.onText?.(block.text);
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            opts.onToolCall?.({ name: block.name, args: block.input });
          }
        }
        return next;
      }
      case 'result': {
        if (typeof line.result === 'string' && line.result.length > 0) {
          // The trailing `result` is the canonical final assistant text.
          return line.result;
        }
        return acc;
      }
      default:
        return acc;
    }
  }

  /**
   * Locate the mailbox-mcp server entry next to this module after build.
   * Layout: dist/runtimes/claude-code-runtime.js → dist/mcp/mailbox-mcp-server.js
   */
  private defaultMcpServerEntry(): string {
    const here = currentFile();
    return resolve(dirname(here), '..', 'mcp', 'mailbox-mcp-server.js');
  }
}

/**
 * Resolve the URL of the current module across both ESM and CJS bundles.
 * Tsup emits two outputs; in CJS `import.meta` is undefined, so fall back
 * to `__dirname`/`__filename` which CJS provides natively.
 */
function currentFile(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — `import.meta` only exists in ESM
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return fileURLToPath(import.meta.url);
    }
  } catch {
    /* swallow */
  }
  // CJS fallback
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cjs = (globalThis as any).__filename as string | undefined;
  if (cjs) return cjs;
  throw new Error(
    'ClaudeCodeRuntime: cannot resolve module path; pass `mcpServerEntry` explicitly',
  );
}

/** Yield each newline-delimited UTF-8 line from a Node Readable stream. */
async function* readNdjson(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function safeParse(line: string): StreamJsonLine | null {
  try {
    return JSON.parse(line) as StreamJsonLine;
  } catch {
    return null;
  }
}

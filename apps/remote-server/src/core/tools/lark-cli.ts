import { execFile } from 'child_process';
import { promisify } from 'util';
import z from 'zod';
import type { Tool } from 'pulse-coder-engine';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_FORMAT = 'json';

const toolSchema = z.object({
  args: z.array(z.string().min(1)).min(1).describe('Arguments passed to lark-cli, e.g. ["auth","status"].'),
  format: z.enum(['json', 'pretty', 'table', 'ndjson', 'csv']).optional().describe('Output format.'),
  appendFormat: z
    .boolean()
    .optional()
    .describe('If true, append --format when not present. Defaults to true (json).'),
  dryRun: z.boolean().optional().describe('If true, append --dry-run when not present.'),
  cwd: z.string().optional().describe('Working directory for the command.'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds. Defaults to 30000.'),
  maxBuffer: z.number().int().positive().optional().describe('Max stdout/stderr buffer in bytes. Defaults to 5MB.'),
  env: z.record(z.string()).optional().describe('Additional environment variables.'),
  binary: z.string().optional().describe('Override lark-cli binary path.'),
});

type LarkCliInput = z.infer<typeof toolSchema>;

interface LarkCliResult {
  ok: boolean;
  command: string;
  args: string[];
  format?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed?: unknown;
  error?: string;
  timedOut?: boolean;
}

export const larkCliTool: Tool<LarkCliInput, LarkCliResult> = {
  name: 'lark_cli',
  description: 'Run LarkSuite CLI (lark-cli). Useful for Feishu/Lark Open Platform operations.',
  defer_loading: true,
  inputSchema: toolSchema,
  execute: async (input): Promise<LarkCliResult> => {
    const command = resolveBinary(input.binary);
    const { args, format } = normalizeArgs(input);
    if (args.length === 0) {
      return {
        ok: false,
        command,
        args,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: 'args resolved to empty after trimming.',
      };
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = input.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const env = buildEnv(input.env);

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: input.cwd,
        timeout: timeoutMs,
        maxBuffer,
        env,
      });

      const parsed = shouldParseJson(format) ? tryParseJson(stdout) : undefined;
      return {
        ok: true,
        command,
        args,
        format,
        exitCode: 0,
        stdout,
        stderr,
        parsed,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number;
        signal?: string;
        killed?: boolean;
      };
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? '';
      const parsed = shouldParseJson(format) ? tryParseJson(stdout) : undefined;
      const timedOut = Boolean(err.killed && err.signal === 'SIGTERM');

      return {
        ok: false,
        command,
        args,
        format,
        exitCode: typeof err.code === 'number' ? err.code : null,
        stdout,
        stderr,
        parsed,
        timedOut,
        error: err.message || 'lark-cli execution failed.',
      };
    }
  },
};

function resolveBinary(override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }
  if (process.env.LARK_CLI_BIN?.trim()) {
    return process.env.LARK_CLI_BIN.trim();
  }
  return 'lark-cli';
}

function normalizeArgs(input: LarkCliInput): { args: string[]; format?: string } {
  const rawArgs = input.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  const args = [...rawArgs];

  const hasFormat = hasFlag(args, '--format') || hasFlag(args, '-f');
  const appendFormat = input.appendFormat ?? true;
  const format = input.format ?? (appendFormat && !hasFormat ? DEFAULT_FORMAT : undefined);

  if (input.dryRun && !hasFlag(args, '--dry-run')) {
    args.push('--dry-run');
  }

  if (format && !hasFormat) {
    args.push('--format', format);
  }

  return { args, format: format ?? extractFormat(args) };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function extractFormat(args: string[]): string | undefined {
  const formatIndex = args.findIndex((arg) => arg === '--format' || arg === '-f');
  if (formatIndex === -1) {
    return undefined;
  }
  return args[formatIndex + 1];
}

function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  if (!extra || Object.keys(extra).length === 0) {
    return process.env;
  }
  return {
    ...process.env,
    ...extra,
  };
}

function shouldParseJson(format?: string): boolean {
  return format === 'json';
}

function tryParseJson(text: string): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

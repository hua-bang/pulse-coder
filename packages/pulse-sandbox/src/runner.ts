import vm from 'vm';
import { inspect } from 'util';

interface RunnerRequest {
  code: string;
  input: unknown;
  maxOutputChars: number;
}

interface RunnerSuccessMessage {
  type: 'success';
  result: unknown;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

interface RunnerErrorMessage {
  type: 'error';
  errorCode: 'RUNTIME_ERROR' | 'INTERNAL';
  errorMessage: string;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

type RunnerMessage = RunnerSuccessMessage | RunnerErrorMessage;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function appendWithLimit(buffer: string, chunk: string, maxChars: number): { value: string; truncated: boolean } {
  const merged = buffer + chunk;

  if (merged.length <= maxChars) {
    return { value: merged, truncated: false };
  }

  return {
    value: merged.slice(0, maxChars),
    truncated: true
  };
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg;
      }

      return inspect(arg, {
        depth: 4,
        breakLength: 120,
        compact: true,
        maxArrayLength: 100
      });
    })
    .join(' ');
}

function createConsoleProxy(
  append: (stream: 'stdout' | 'stderr', text: string) => void
): Console {
  return {
    log: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    info: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    warn: (...args: unknown[]) => append('stderr', `${formatLogArgs(args)}\n`),
    error: (...args: unknown[]) => append('stderr', `${formatLogArgs(args)}\n`),
    debug: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    trace: (...args: unknown[]) => append('stderr', `${formatLogArgs(args)}\n`),
    dir: (item: unknown) => append('stdout', `${inspect(item)}\n`),
    dirxml: (item: unknown) => append('stdout', `${inspect(item)}\n`),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) {
        append('stderr', `${formatLogArgs(args.length ? args : ['Assertion failed'])}\n`);
      }
    },
    clear: () => {},
    count: () => {},
    countReset: () => {},
    group: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    groupCollapsed: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    groupEnd: () => {},
    table: (tabularData: unknown) => append('stdout', `${inspect(tabularData, { depth: 3 })}\n`),
    time: () => {},
    timeLog: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    timeEnd: (...args: unknown[]) => append('stdout', `${formatLogArgs(args)}\n`),
    timeStamp: () => {},
    profile: () => {},
    profileEnd: () => {}
  } as unknown as Console;
}

function buildSandbox(input: unknown, consoleProxy: Console): vm.Context {
  const sandbox: Record<string, unknown> = {
    input,
    console: consoleProxy,
    fetch: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    require: undefined,
    process: undefined,
    module: undefined,
    exports: undefined,
    Buffer: undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  return vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });
}

async function executeInSandbox(payload: RunnerRequest): Promise<RunnerMessage> {
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;

  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    if (stream === 'stdout') {
      const next = appendWithLimit(stdout, text, payload.maxOutputChars);
      stdout = next.value;
      if (next.truncated) {
        outputTruncated = true;
      }
      return;
    }

    const next = appendWithLimit(stderr, text, payload.maxOutputChars);
    stderr = next.value;
    if (next.truncated) {
      outputTruncated = true;
    }
  };

  try {
    const consoleProxy = createConsoleProxy(append);
    const context = buildSandbox(payload.input, consoleProxy);
    const wrappedCode = `'use strict';\n(async () => {\n${payload.code}\n})()`;
    const script = new vm.Script(wrappedCode, { filename: 'pulse-sandbox-user-code.js' });
    const result = await script.runInContext(context);

    return {
      type: 'success',
      result,
      stdout,
      stderr,
      outputTruncated
    };
  } catch (error) {
    append('stderr', `${toErrorMessage(error)}\n`);

    return {
      type: 'error',
      errorCode: 'RUNTIME_ERROR',
      errorMessage: toErrorMessage(error),
      stdout,
      stderr,
      outputTruncated
    };
  }
}

function sendAndExit(message: RunnerMessage, exitCode: number): void {
  if (!process.send) {
    process.exit(exitCode);
    return;
  }

  process.send(message, (error) => {
    if (error) {
      process.exit(1);
      return;
    }

    process.exit(exitCode);
  });
}

process.once('message', async (payload: RunnerRequest) => {
  try {
    const result = await executeInSandbox(payload);
    sendAndExit(result, 0);
  } catch (error) {
    const fallback: RunnerErrorMessage = {
      type: 'error',
      errorCode: 'INTERNAL',
      errorMessage: toErrorMessage(error),
      stdout: '',
      stderr: toErrorMessage(error),
      outputTruncated: false
    };

    sendAndExit(fallback, 1);
  }
});

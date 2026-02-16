import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  JsExecutionErrorCode,
  JsExecutionRequest,
  JsExecutionResult,
  JsExecutor,
  JsExecutorOptions
} from './types.js';

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

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MEMORY_LIMIT_MB = 64;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_MAX_CODE_LENGTH = 20_000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
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

function clampText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return {
    value: value.slice(0, maxChars),
    truncated: true
  };
}

function mergeText(first: string, second: string): string {
  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  return `${first}\n${second}`;
}

function inferExitErrorCode(signal: NodeJS.Signals | null, stderr: string): JsExecutionErrorCode {
  if (signal === 'SIGABRT' || /heap out of memory/i.test(stderr)) {
    return 'OOM';
  }

  return 'INTERNAL';
}

function createErrorResult(
  startedAt: number,
  stdout: string,
  stderr: string,
  errorCode: JsExecutionErrorCode,
  errorMessage: string,
  outputTruncated: boolean
): JsExecutionResult {
  return {
    ok: false,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    outputTruncated,
    error: {
      code: errorCode,
      message: errorMessage
    }
  };
}

function resolveRunnerPath(): string {
  const requireForResolve = createRequire(import.meta.url);
  const localDir = path.dirname(fileURLToPath(import.meta.url));
  const localCandidates = [path.join(localDir, 'runner.js'), path.join(localDir, 'runner.cjs')];

  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const packageEntryPath = requireForResolve.resolve('pulse-sandbox');
    const packageDir = path.dirname(packageEntryPath);
    const packageCandidates = [path.join(packageDir, 'runner.js'), path.join(packageDir, 'runner.cjs')];

    for (const candidate of packageCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Ignore and fall through to final fallback.
  }

  return localCandidates[0];
}

export function createJsExecutor(options: JsExecutorOptions = {}): JsExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const maxCodeLength = options.maxCodeLength ?? DEFAULT_MAX_CODE_LENGTH;

  return {
    async execute(request: JsExecutionRequest): Promise<JsExecutionResult> {
      const startedAt = Date.now();
      const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;

      if (!Number.isInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
        return createErrorResult(
          startedAt,
          '',
          '',
          'POLICY_BLOCKED',
          'timeoutMs must be a positive integer.',
          false
        );
      }

      if (!request.code || request.code.trim().length === 0) {
        return createErrorResult(
          startedAt,
          '',
          '',
          'POLICY_BLOCKED',
          'code must be a non-empty string.',
          false
        );
      }

      if (request.code.length > maxCodeLength) {
        return createErrorResult(
          startedAt,
          '',
          '',
          'POLICY_BLOCKED',
          `code exceeds maxCodeLength (${maxCodeLength}).`,
          false
        );
      }

      const runnerPath = resolveRunnerPath();

      return new Promise<JsExecutionResult>((resolve) => {
        let child: ChildProcess | undefined;
        let finished = false;
        let timedOut = false;
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let streamTruncated = false;

        const finish = (result: JsExecutionResult): void => {
          if (finished) {
            return;
          }

          finished = true;
          resolve(result);
        };

        try {
          child = fork(runnerPath, {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'advanced',
            execArgv: [`--max-old-space-size=${memoryLimitMb}`]
          });
        } catch (error) {
          finish(
            createErrorResult(
              startedAt,
              '',
              '',
              'INTERNAL',
              `Failed to start sandbox process: ${toErrorMessage(error)}`,
              false
            )
          );
          return;
        }

        const timeoutHandle = setTimeout(() => {
          if (finished) {
            return;
          }

          timedOut = true;
          child?.kill('SIGKILL');
        }, effectiveTimeoutMs);

        const collectStreamChunk = (source: 'stdout' | 'stderr', chunk: string): void => {
          const currentBuffer = source === 'stdout' ? stdoutBuffer : stderrBuffer;
          const next = appendWithLimit(currentBuffer, chunk, maxOutputChars);

          if (next.truncated) {
            streamTruncated = true;
          }

          if (source === 'stdout') {
            stdoutBuffer = next.value;
            return;
          }

          stderrBuffer = next.value;
        };

        child.stdout?.on('data', (chunk: Buffer | string) => {
          collectStreamChunk('stdout', String(chunk));
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          collectStreamChunk('stderr', String(chunk));
        });

        child.once('error', (error) => {
          clearTimeout(timeoutHandle);
          finish(
            createErrorResult(
              startedAt,
              stdoutBuffer,
              stderrBuffer,
              'INTERNAL',
              `Sandbox process error: ${toErrorMessage(error)}`,
              streamTruncated
            )
          );
        });

        child.once('message', (message: RunnerMessage) => {
          clearTimeout(timeoutHandle);

          const mergedStdout = mergeText(message.stdout, stdoutBuffer);
          const mergedStderr = mergeText(message.stderr, stderrBuffer);

          const clampedStdout = clampText(mergedStdout, maxOutputChars);
          const clampedStderr = clampText(mergedStderr, maxOutputChars);
          const outputTruncated =
            message.outputTruncated ||
            streamTruncated ||
            clampedStdout.truncated ||
            clampedStderr.truncated;

          if (message.type === 'success') {
            finish({
              ok: true,
              result: message.result,
              stdout: clampedStdout.value,
              stderr: clampedStderr.value,
              durationMs: Date.now() - startedAt,
              outputTruncated
            });
            if (child.connected) {
              child.disconnect();
            }
            return;
          }

          finish(
            createErrorResult(
              startedAt,
              clampedStdout.value,
              clampedStderr.value,
              message.errorCode,
              message.errorMessage,
              outputTruncated
            )
          );
          if (child.connected) {
            child.disconnect();
          }
        });

        child.once('exit', (_code, signal) => {
          clearTimeout(timeoutHandle);

          if (finished) {
            return;
          }

          if (timedOut) {
            finish(
              createErrorResult(
                startedAt,
                stdoutBuffer,
                stderrBuffer,
                'TIMEOUT',
                `Execution timed out after ${effectiveTimeoutMs}ms.`,
                streamTruncated
              )
            );
            return;
          }

          const errorCode = inferExitErrorCode(signal, stderrBuffer);
          finish(
            createErrorResult(
              startedAt,
              stdoutBuffer,
              stderrBuffer,
              errorCode,
              'Sandbox process exited unexpectedly.',
              streamTruncated
            )
          );
        });

        const payload: RunnerRequest = {
          code: request.code,
          input: request.input,
          maxOutputChars
        };

        try {
          child.send(payload);
        } catch (error) {
          clearTimeout(timeoutHandle);
          child.kill('SIGKILL');
          finish(
            createErrorResult(
              startedAt,
              stdoutBuffer,
              stderrBuffer,
              'INTERNAL',
              `Failed to send payload to sandbox: ${toErrorMessage(error)}`,
              streamTruncated
            )
          );
        }
      });
    }
  };
}

export type JsExecutionErrorCode =
  | 'TIMEOUT'
  | 'OOM'
  | 'RUNTIME_ERROR'
  | 'POLICY_BLOCKED'
  | 'INTERNAL';

export interface JsExecutionError {
  code: JsExecutionErrorCode;
  message: string;
}

export interface JsExecutionRequest {
  code: string;
  input?: unknown;
  timeoutMs?: number;
}

export interface JsExecutionResult {
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: JsExecutionError;
  durationMs: number;
  outputTruncated: boolean;
}

export interface JsExecutor {
  execute(request: JsExecutionRequest): Promise<JsExecutionResult>;
}

export interface JsExecutorOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxOutputChars?: number;
  maxCodeLength?: number;
}

export interface RunJsToolInput {
  code: string;
  input?: unknown;
  timeoutMs?: number;
}

export type RunJsToolOutput = JsExecutionResult;

export interface RunJsToolOptions {
  executor: JsExecutor;
  name?: string;
  description?: string;
}

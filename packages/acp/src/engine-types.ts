export interface ToolExecutionContext {
  onClarificationRequest?: (request: {
    id: string;
    question: string;
    context?: string;
    defaultAnswer?: string;
    timeout: number;
  }) => Promise<string>;
  abortSignal?: AbortSignal;
  runContext?: Record<string, any>;
}

export interface Tool<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  allowed_callers?: string[];
  defer_loading?: boolean;
  deferLoading?: boolean;
  execute: (input: Input, context?: ToolExecutionContext) => Promise<Output>;
}

export interface EnginePluginContext {
  registerService<T>(name: string, service: T): void;
  registerTool(name: string, tool: any): void;
  logger: {
    info(message: string, meta?: any): void;
  };
}

type EnginePluginInit = (context: EnginePluginContext) => Promise<void>;

export interface EnginePlugin {
  name: string;
  version: string;
  initialize: EnginePluginInit;
}

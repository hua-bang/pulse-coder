/**
 * AgentRunner: 编排层与执行层之间的抽象边界。
 * 编排层只知道"用哪个 agent 跑什么任务"，不感知底层是 engine、HTTP 还是其他实现。
 */
export interface AgentRunInput {
  agentName: string;
  task: string;
  context?: Record<string, any>;
}

export interface AgentRunner {
  /** 执行一个 agent，返回文本结果 */
  run(input: AgentRunInput): Promise<string>;
  /** 返回当前可用的 agent 名称列表 */
  getAvailableAgents(): string[];
}

export interface OrchestratorLogger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, error?: Error, meta?: any): void;
}

export const defaultLogger: OrchestratorLogger = {
  debug: () => {},
  info: (msg) => console.log(`[Orchestrator] ${msg}`),
  warn: (msg) => console.warn(`[Orchestrator] ${msg}`),
  error: (msg, err) => console.error(`[Orchestrator] ${msg}`, err ?? ''),
};

import type { AgentRunner, AgentRunInput } from '../runner';

/**
 * EngineAgentRunner
 *
 * 将 engine 的工具系统适配为 AgentRunner 接口。
 * engine 层注册的 xxx_agent 工具可以直接被 Orchestrator 驱动。
 *
 * 使用方式：
 *   const runner = new EngineAgentRunner(context.getTools());
 *   const orchestrator = new Orchestrator({ runner });
 */
export class EngineAgentRunner implements AgentRunner {
  constructor(private tools: Record<string, any>) {}

  async run(input: AgentRunInput): Promise<string> {
    const tool = this.tools[input.agentName];
    if (!tool) {
      throw new Error(`Agent tool not found: ${input.agentName}`);
    }
    const output = await tool.execute({ task: input.task, context: input.context });
    return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  }

  getAvailableAgents(): string[] {
    return Object.keys(this.tools).filter(name => name.endsWith('_agent'));
  }
}

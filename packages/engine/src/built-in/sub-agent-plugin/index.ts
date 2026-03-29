import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { Context } from '../../shared/types.js';
import { loop } from '../../core/loop';
import { BuiltinToolsMap } from '../../tools';
import type { Tool } from '../../shared/types';

interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  filePath: string;
  deferLoading?: boolean;
}

class ConfigLoader {

  async getAgentFilesInfo(configDirs: string[]) {
    const fileInfos: Array<{ files: string[], configDir: string }> = [];
    for (let configDir of configDirs) {
      try {
        await fs.access(configDir);

        const files = await fs.readdir(configDir);
        fileInfos.push({ files, configDir });
      } catch {
        continue;
      }
    }

    return fileInfos;
  }

  async loadAgentConfigs(configDir: string | string[] = ['.pulse-coder/agents', '.coder/agents']): Promise<AgentConfig[]> {
    const configs: AgentConfig[] = [];

    const configDirs = Array.isArray(configDir) ? configDir : [configDir];

    try {
      const filesInfo = await this.getAgentFilesInfo(configDirs);

      for (const fileInfo of filesInfo) {
        const files = fileInfo.files;
        for (const file of files) {
          if (file.endsWith('.md')) {
            const config = await this.parseConfig(path.join(fileInfo.configDir, file));
            if (config) configs.push(config);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to scan agent configs: ${error}`);
    }

    return configs;
  }

  private async parseConfig(filePath: string): Promise<AgentConfig | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      let name = '';
      let description = '';
      let systemPrompt = '';
      let deferLoading: boolean | undefined;
      let inFrontmatter = false;
      let frontmatterEnd = false;

      for (const line of lines) {
        if (line.trim() === '---') {
          if (!inFrontmatter) {
            inFrontmatter = true;
            continue;
          } else {
            frontmatterEnd = true;
            continue;
          }
        }

        if (inFrontmatter && !frontmatterEnd) {
          const match = line.match(/^\s*(\w+)\s*:\s*(.+)$/);
          if (match) {
            const [, key, value] = match;
            const normalizedValue = value.trim();
            if (key === 'name') name = normalizedValue;
            if (key === 'description') description = normalizedValue;
            if (key === 'defer_loading' || key === 'deferLoading') {
              if (normalizedValue === 'true') deferLoading = true;
              if (normalizedValue === 'false') deferLoading = false;
            }
          }
        } else if (frontmatterEnd) {
          systemPrompt += line + '\n';
        }
      }

      if (!name) {
        name = path.basename(filePath, '.md');
      }

      return {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        filePath,
        deferLoading,
      };
    } catch (error) {
      console.warn(`Failed to parse agent config ${filePath}: ${error}`);
      return null;
    }
  }
}

class AgentRunner {
  async runAgent(
    config: AgentConfig,
    task: string,
    context?: Record<string, any>,
    tools?: Record<string, any>,
    callbacks?: {
      onText?: (delta: string) => void;
      onToolCall?: (toolCall: any) => void;
      onToolResult?: (toolResult: any) => void;
    }
  ): Promise<string> {
    const subContext: Context = {
      messages: [
        { role: 'user', content: task }
      ]
    };

    if (context && Object.keys(context).length > 0) {
      subContext.messages.push({
        role: 'user',
        content: `上下文信息：\n${JSON.stringify(context, null, 2)}`
      });
    }

    return await loop(subContext, {
      tools,
      systemPrompt: config.systemPrompt,
      onText: callbacks?.onText,
      onToolCall: callbacks?.onToolCall,
      onToolResult: callbacks?.onToolResult,
    });
  }
}

export class SubAgentPlugin implements EnginePlugin {
  name = 'sub-agent';
  version = '1.0.0';

  private configLoader = new ConfigLoader();
  private agentRunner = new AgentRunner();

  async initialize(context: EnginePluginContext): Promise<void> {
    try {
      const configs = await this.configLoader.loadAgentConfigs();

      for (const config of configs) {
        this.registerAgentTool(context, config);
      }

      context.logger.info(`SubAgentPlugin loaded ${configs.length} agents.`);
    } catch (error) {
      context.logger.error('Failed to initialize SubAgentPlugin', error as Error);
    }
  }

  private registerAgentTool(
    context: EnginePluginContext,
    config: AgentConfig
  ): void {
    const toolName = `${config.name}_agent`;

    const tool: Tool = {
      name: toolName,
      description: config.description,
      ...(config.deferLoading === true ? { defer_loading: true } : {}),
      inputSchema: z.object({
        task: z.string().describe('要执行的任务描述'),
        context: z.any().optional().describe('任务上下文信息')
      }),
      execute: async ({ task, context: taskContext }: { task: string; context?: Record<string, any> }) => {
        // 延迟求值：在工具真正被调用时合并 builtin 工具与所有已注册插件工具，
        // 避免初始化阶段的静态快照导致后注册的插件工具缺失。
        const tools = { ...BuiltinToolsMap, ...context.getTools() };
        const tag = `[agent:${config.name}]`;
        const log = (msg: string) => process.stdout.write(`  \x1b[35m${tag}\x1b[0m ${msg}\n`);
        try {
          log(`Running: ${task.slice(0, 80)}${task.length > 80 ? '...' : ''}`);
          const result = await this.agentRunner.runAgent(config, task, taskContext, tools, {
            onToolCall: (toolCall) => {
              const name = toolCall?.toolName ?? toolCall?.name ?? 'tool';
              log(`🔧 ${name}`);
            },
            onToolResult: (toolResult) => {
              const name = (toolResult as any)?.toolName ?? (toolResult as any)?.name ?? 'tool';
              log(`✅ ${name}`);
            },
          });
          log('Done');
          return result;
        } catch (error) {
          log(`❌ Failed: ${error}`);
          throw new Error(`Agent ${config.name} failed: ${error}`);
        }
      }
    };

    context.registerTool(toolName, tool);
  }

  async destroy(context: EnginePluginContext): Promise<void> {
    context.logger.info('SubAgentPlugin destroyed');
  }
}

export default SubAgentPlugin;
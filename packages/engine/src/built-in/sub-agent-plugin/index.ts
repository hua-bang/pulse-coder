import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import type { Context } from '../../shared/types.js';
import { loop } from '../../core/loop';
import { BuiltinToolsMap } from '../../tools';
import { Tool } from 'ai';

interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  filePath: string;
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
            if (key === 'name') name = value.trim();
            if (key === 'description') description = value.trim();
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
        filePath
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
    tools?: Record<string, any>
  ): Promise<string> {
    const subContext: Context = {
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: task }
      ]
    };

    if (context && Object.keys(context).length > 0) {
      subContext.messages.push({
        role: 'user',
        content: `上下文信息：\n${JSON.stringify(context, null, 2)}`
      });
    }

    return await loop(subContext, { tools });
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

      // 获取插件管理器提供的所有工具
      const tools = this.getAvailableTools(context);

      for (const config of configs) {
        this.registerAgentTool(context, config, tools);
      }

      context.logger.info(`SubAgentPlugin loaded ${configs.length} agents.`);
    } catch (error) {
      context.logger.error('Failed to initialize SubAgentPlugin', error as Error);
    }
  }

  private getAvailableTools(context: EnginePluginContext): Record<string, any> {
    // 从插件上下文中获取所有注册的工具
    // 在初始化阶段，所有工具已经通过插件系统注册
    const allTools: Record<string, any> = {};

    // 这里我们假设工具通过某种方式可用
    // 实际使用时，引擎会提供所有可用的工具
    return BuiltinToolsMap;
  }

  private registerAgentTool(
    context: EnginePluginContext,
    config: AgentConfig,
    tools: Record<string, any>
  ): void {
    const toolName = `${config.name}_agent`;

    const tool: Tool = {
      description: config.description,
      inputSchema: z.object({
        task: z.string().describe('要执行的任务描述'),
        context: z.any().optional().describe('任务上下文信息')
      }),
      execute: async ({ task, context: taskContext }: { task: string; context?: Record<string, any> }) => {
        try {
          context.logger.info(`Running agent ${config.name}: ${task}`);
          const result = await this.agentRunner.runAgent(config, task, taskContext, tools);
          context.logger.info(`Agent ${config.name} completed successfully`);
          return result;
        } catch (error) {
          context.logger.error(`Agent ${config.name} failed`, error as Error);
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
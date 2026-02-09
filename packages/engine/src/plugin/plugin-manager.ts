import type {
  IPlugin,
  IPluginContext,
  Tool,
  SkillInfo,
  PromptSegment,
  MCPServerConfig,
} from '../shared/types';

export class PluginManager {
  private plugins: IPlugin[] = [];
  private tools: Map<string, Tool> = new Map();
  private prompts: PromptSegment[] = [];
  private skills: SkillInfo[] = [];
  private mcpServers: MCPServerConfig[] = [];

  async loadPlugin(plugin: IPlugin): Promise<void> {
    const context: IPluginContext = {
      registerTool: (tool) => {
        this.tools.set(tool.name, tool);
      },
      registerTools: (tools) => {
        for (const tool of tools) {
          this.tools.set(tool.name, tool);
        }
      },
      registerPrompt: (prompt) => {
        this.prompts.push(prompt);
      },
      registerSkill: (skill) => {
        this.skills.push(skill);
      },
      registerSkills: (skills) => {
        this.skills.push(...skills);
      },
      registerMCP: (config) => {
        this.mcpServers.push(config);
      },
      logger: console,
    };

    await plugin.activate(context);
    this.plugins.push(plugin);
  }

  async unloadAll(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.deactivate?.();
    }
    this.plugins = [];
    this.tools.clear();
    this.prompts = [];
    this.skills = [];
    this.mcpServers = [];
  }

  getTools(): Record<string, Tool> {
    return Object.fromEntries(this.tools);
  }

  getPrompts(): PromptSegment[] {
    return [...this.prompts].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );
  }

  getSkills(): SkillInfo[] {
    return [...this.skills];
  }

  getMCPServers(): MCPServerConfig[] {
    return [...this.mcpServers];
  }

  getPlugins(): IPlugin[] {
    return [...this.plugins];
  }
}

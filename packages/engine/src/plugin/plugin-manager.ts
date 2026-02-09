import type {
  IPlugin,
  IPluginContext,
  IProvider,
  Provider,
  ToolProvider,
  PromptProvider,
  Tool,
  PromptSegment,
} from '../shared/types';

export class PluginManager {
  private plugins: IPlugin[] = [];
  private providers: IProvider[] = [];
  private tools: Map<string, Tool> = new Map();
  private prompts: PromptSegment[] = [];

  // ========== Provider Management ==========

  registerProvider(provider: Provider): void {
    this.providers.push(provider);

    // ToolProvider and PromptProvider are processed directly by the engine
    // (no plugin needed to handle them)
    if (provider.type === 'tool') {
      for (const tool of (provider as ToolProvider).tools) {
        this.tools.set(tool.name, tool);
      }
    }

    if (provider.type === 'prompt') {
      this.prompts.push(...(provider as PromptProvider).prompts);
    }
  }

  getProviders<T extends IProvider>(type: string): T[] {
    return this.providers.filter((p) => p.type === type) as T[];
  }

  // ========== Plugin Management ==========

  async loadPlugin(plugin: IPlugin): Promise<void> {
    const context: IPluginContext = {
      registerTool: (tool) => {
        this.tools.set(tool.name, tool);
      },
      registerPrompt: (prompt) => {
        this.prompts.push(prompt);
      },
      getProviders: <T extends IProvider>(type: string) => {
        return this.getProviders<T>(type);
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
    this.providers = [];
    this.tools.clear();
    this.prompts = [];
  }

  // ========== Getters ==========

  getTools(): Record<string, Tool> {
    return Object.fromEntries(this.tools);
  }

  getPrompts(): PromptSegment[] {
    return [...this.prompts].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );
  }

  getPlugins(): IPlugin[] {
    return [...this.plugins];
  }
}

import type { IPlugin, Provider, Context } from './shared/types';
import { loop, type LoopOptions } from './core/loop';
import { BuiltinToolsMap } from './tools/index';
import { PluginManager } from './plugin/plugin-manager';
import { generateSystemPrompt } from './prompt';

export class Engine {
  private pluginManager = new PluginManager();
  private builtinTools: Record<string, any> = { ...BuiltinToolsMap };

  // ========== Provider (Resource Layer) ==========

  registerProvider(provider: Provider): void {
    this.pluginManager.registerProvider(provider);
  }

  // ========== Plugin (Mechanism Layer) ==========

  async loadPlugin(plugin: IPlugin): Promise<void> {
    await this.pluginManager.loadPlugin(plugin);
  }

  // ========== Execution ==========

  async run(context: Context, options?: LoopOptions): Promise<string> {
    const tools = this.buildTools();
    const systemPrompt = this.buildSystemPrompt();

    return loop(context, {
      ...options,
      tools,
      systemPrompt,
      onToolCall: (toolCall) => {
        options?.onToolCall?.(toolCall);
      },
    });
  }

  private buildTools(): Record<string, any> {
    const pluginTools = this.pluginManager.getTools();
    return { ...this.builtinTools, ...pluginTools };
  }

  private buildSystemPrompt(): string {
    const pluginPrompts = this.pluginManager.getPrompts();
    return generateSystemPrompt(pluginPrompts);
  }

  getPluginManager(): PluginManager {
    return this.pluginManager;
  }
}

export * from './shared/types';
export { loop } from './core/loop';
export type { LoopOptions } from './core/loop';
export { streamTextAI } from './ai';
export { maybeCompactContext } from './context';
export * from './tools/index';
export * from './config';
export { PluginManager } from './plugin/plugin-manager';
export { generateSkillTool } from './plugin/skill-tool';

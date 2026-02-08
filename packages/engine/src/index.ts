import type { IPlugin, Context } from './shared/types.js';
import { loop, type LoopOptions } from './core/loop.js';
import { BuiltinToolsMap } from './extensions/tools';
import { streamTextAI } from './extensions/ai.js';
import { maybeCompactContext } from './extensions/context.js';

export class Engine {
  private plugins: IPlugin[] = [];
  private tools: Record<string, any> = { ...BuiltinToolsMap };

  async loadPlugin(plugin: IPlugin): Promise<void> {
    this.plugins.push(plugin);
    const context = {
      registerExtension: (type: string, provider: any) => {
        if (type === 'tool') {
          this.tools[provider.name] = provider;
        }
      },
      logger: console,
    };
    await plugin.activate(context);
  }

  async run(context: Context, options?: LoopOptions): Promise<string> {
    return loop(context, {
      ...options,
      onToolCall: (toolCall) => {
        options?.onToolCall?.(toolCall);
      },
    });
  }

  getTools(): Record<string, any> {
    return this.tools;
  }

  getPlugins(): IPlugin[] {
    return this.plugins;
  }
}

export * from './shared/types.js';
export { loop } from './core/loop.js';
export { streamTextAI } from './extensions/ai.js';
export { maybeCompactContext } from './extensions/context.js';
export * from './extensions/tools';
export * from './config';
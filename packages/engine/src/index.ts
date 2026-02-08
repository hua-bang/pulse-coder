import type { IPlugin, Context } from './shared/types';
import { loop, type LoopOptions } from './core/loop';
import { BuiltinToolsMap } from './tools/index';
import { streamTextAI } from './ai';

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

export * from './shared/types';
export { loop } from './core/loop';
export { streamTextAI } from './ai';
export { maybeCompactContext } from './context';
export * from './tools/index';
export * from './config';
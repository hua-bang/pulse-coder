import type { IPlugin, Context } from './shared/types';
import { loop, type LoopOptions } from './core/loop';
import { BuiltinToolsMap } from './tools/index';
import { Tool } from 'ai';

interface EngineOptions {
  plugins?: IPlugin[];
}

export class Engine {
  private plugins: IPlugin[] = [];
  private tools: Record<string, any> = { ...BuiltinToolsMap };

  constructor(options?: EngineOptions) {
    this.plugins = options?.plugins || [];

    this.plugins.forEach((plugin) => {
      this.tools[plugin.name] = plugin;
    });
  }

  async loadPlugin(plugin: IPlugin): Promise<void> {
    this.plugins.push(plugin);
    const context = {
      registerTools: (toolName: string, tool: Tool) => {
        const name = toolName;
        this.tools[name] = tool;
      },
      logger: console,
    };
    await plugin.activate(context);
  }

  async run(context: Context, options?: LoopOptions): Promise<string> {
    return loop(context, {
      ...options,
      tools: this.tools, // 传入引擎的工具
      onToolCall: (toolCall) => {
        options?.onToolCall?.(toolCall);
      },
    });
  }
}

export * from './shared/types';
export { loop } from './core/loop';
export { streamTextAI } from './ai';
export { maybeCompactContext } from './context';
export * from './tools/index';
export * from './config';
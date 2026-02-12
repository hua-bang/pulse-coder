import type { Context } from './shared/types';
import type { LoopOptions } from './core/loop';
import type { EnginePluginLoadOptions } from './plugin/EnginePlugin.js';
import type { UserConfigPluginLoadOptions } from './plugin/UserConfigPlugin.js';

import { loop } from './core/loop.js';
import { BuiltinToolsMap } from './tools/index.js';
import { PluginManager } from './plugin/PluginManager.js';
import { builtInPlugins } from './built-in/index.js';

/**
 * 引擎配置选项
 */
export interface EngineOptions {
  // 引擎插件配置
  enginePlugins?: EnginePluginLoadOptions;

  // 用户配置插件配置
  userConfigPlugins?: UserConfigPluginLoadOptions;

  // 是否禁用内置插件（默认启用）
  disableBuiltInPlugins?: boolean;

  // 全局配置
  config?: Record<string, any>;
}

/**
 * 重构后的引擎类
 * 自动包含内置插件，支持可选禁用
 */
export class Engine {
  private pluginManager: PluginManager;
  private tools: Record<string, any> = { ...BuiltinToolsMap };
  private options: EngineOptions = {};
  private config: Record<string, any> = {};

  constructor(options?: EngineOptions) {
    this.pluginManager = new PluginManager();

    // 初始化全局配置
    this.config = options?.config || {};
    this.options = options || {};
  }

  /**
   * 初始化引擎和插件系统
   * 自动包含内置插件
   */
  async initialize(): Promise<void> {
    console.log('Initializing engine...', this.config);

    // 准备插件列表：内置插件 + 用户配置插件
    const allEnginePlugins = this.prepareEnginePlugins();

    // 插件管理器会自动处理加载顺序
    await this.pluginManager.initialize({
      enginePlugins: {
        ...allEnginePlugins
      },
      userConfigPlugins: {
        ...(this.options.userConfigPlugins || {})
      }
    });

    // 合并插件工具到引擎工具库
    const pluginTools = this.pluginManager.getTools();
    this.tools = { ...this.tools, ...pluginTools };
  }

  /**
   * 准备引擎插件列表（包含内置插件）
   */
  private prepareEnginePlugins(): EnginePluginLoadOptions {
    const userPlugins = this.options.enginePlugins || {};
    
    // 如果用户禁用了内置插件，只返回用户插件
    if (this.options.disableBuiltInPlugins) {
      return userPlugins;
    }

    // 合并内置插件和用户插件
    const builtInPluginList = [...builtInPlugins];
    const userPluginList = userPlugins.plugins || [];

    return {
      plugins: [...builtInPluginList, ...userPluginList],
      dirs: userPlugins.dirs || ['.coder/engine-plugins', '~/.coder/engine-plugins'],
      scan: userPlugins.scan !== false // 默认启用扫描
    };
  }

  /**
   * 运行AI循环
   */
  async run(context: Context, options?: LoopOptions): Promise<string> {
    return loop(context, {
      ...options,
      tools: this.tools,
      onToolCall: (toolCall) => {
        options?.onToolCall?.(toolCall);
      },
      onClarificationRequest: options?.onClarificationRequest,
    });
  }

  /**
   * 获取插件状态
   */
  getPluginStatus() {
    return this.pluginManager.getStatus();
  }

  /**
   * 获取工具
   */
  getTools(): Record<string, any> {
    return { ...this.tools };
  }

  /**
   * 获取服务
   */
  getService<T>(name: string): T | undefined {
    return this.pluginManager.getService<T>(name);
  }

  /**
   * 获取配置
   */
  getConfig<T>(key: string): T | undefined {
    return this.config[key];
  }

  /**
   * 设置配置
   */
  setConfig<T>(key: string, value: T): void {
    this.config[key] = value;
  }
}

// 重新导出类型
export * from './shared/types.js';
export * from './plugin/EnginePlugin.js';
export * from './plugin/UserConfigPlugin.js';
export { loop } from './core/loop.js';
export { streamTextAI } from './ai/index.js';
export { maybeCompactContext } from './context/index.js';
export * from './tools/index.js';
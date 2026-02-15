import type { Context, Tool, LLMProviderFactory, SystemPromptOption, ToolHooks, ILogger } from './shared/types';
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

  /**
   * 自定义 LLM Provider。
   * 接收模型名称，返回 Vercel AI SDK LanguageModel 实例。
   * 未设置时使用环境变量配置的默认 Provider（OpenAI / Anthropic）。
   *
   * @example
   * import { createOpenAI } from '@ai-sdk/openai';
   * const engine = new Engine({
   *   llmProvider: createOpenAI({ apiKey: 'sk-...', baseURL: 'https://my-proxy/v1' }).chat,
   *   model: 'gpt-4o',
   * });
   */
  llmProvider?: LLMProviderFactory;

  /**
   * 模型名称，传递给 llmProvider。未设置时使用 DEFAULT_MODEL。
   */
  model?: string;

  /**
   * 直接注册自定义工具，无需创建 EnginePlugin。
   * 这些工具会与内置工具以及插件注册的工具合并。
   * 若与内置工具同名，自定义工具优先级更高。
   *
   * @example
   * import { z } from 'zod';
   * const engine = new Engine({
   *   tools: {
   *     myTool: {
   *       name: 'myTool',
   *       description: '查询内部数据库',
   *       inputSchema: z.object({ query: z.string() }),
   *       execute: async ({ query }) => fetchFromDB(query),
   *     },
   *   },
   * });
   */
  tools?: Record<string, Tool>;

  /**
   * 自定义 System Prompt，三种形式：
   * - `string` — 完全替换内置 prompt
   * - `() => string` — 工厂函数，每次请求调用（支持动态 prompt）
   * - `{ append: string }` — 在内置 prompt 末尾追加业务上下文
   *
   * @example
   * const engine = new Engine({
   *   systemPrompt: { append: '公司规范：所有变量使用 camelCase。禁止使用 any 类型。' },
   * });
   */
  systemPrompt?: SystemPromptOption;

  /**
   * Tool 执行钩子，在每次工具调用前/后触发。
   * - `onBeforeToolCall` 可以修改入参，或抛错来拦截调用。
   * - `onAfterToolCall` 可以修改返回值（如脱敏、截断）。
   *
   * @example
   * const engine = new Engine({
   *   hooks: {
   *     onBeforeToolCall: (name, input) => {
   *       if (name === 'bash') throw new Error('bash 工具已被禁用');
   *     },
   *     onAfterToolCall: (name, input, output) => {
   *       auditLogger.log({ name, input, output });
   *       return output;
   *     },
   *   },
   * });
   */
  hooks?: ToolHooks;

  /**
   * 自定义日志实现。未设置时使用 console.*。
   * 兼容 winston / pino 等主流日志库。
   *
   * @example
   * import pino from 'pino';
   * const logger = pino();
   * const engine = new Engine({ logger });
   */
  logger?: ILogger;
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
    this.pluginManager = new PluginManager(options?.logger);

    // 初始化全局配置
    this.config = options?.config || {};
    this.options = options || {};
  }

  /**
   * 初始化引擎和插件系统
   * 自动包含内置插件
   */
  async initialize(): Promise<void> {
    const log = this.options.logger ?? console;
    log.info('Initializing engine...');

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

    // 合并业务方直接传入的自定义工具（优先级最高，可覆盖内置工具）
    if (this.options.tools) {
      this.tools = { ...this.tools, ...this.options.tools };
    }
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
      dirs: userPlugins.dirs || ['.pulse-coder/engine-plugins', '.coder/engine-plugins', '~/.pulse-coder/engine-plugins', '~/.coder/engine-plugins'],
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
      // Engine 级别选项作为默认值；调用方通过 options 传入可在单次调用中覆盖
      provider: options?.provider ?? this.options.llmProvider,
      model: options?.model ?? this.options.model,
      systemPrompt: options?.systemPrompt ?? this.options.systemPrompt,
      hooks: options?.hooks ?? this.options.hooks,
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
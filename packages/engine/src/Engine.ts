import type { Context, Tool, LLMProviderFactory, SystemPromptOption, ToolHooks, ILogger } from './shared/types';
import type { LoopOptions, LoopHooks } from './core/loop';
import type { EnginePluginLoadOptions } from './plugin/EnginePlugin.js';
import type { UserConfigPluginLoadOptions } from './plugin/UserConfigPlugin.js';
import type { PlanMode, PlanModeService } from './built-in/index.js';
import type { RemoteSkillConfig } from './built-in/skills-plugin/index.js';

import { loop } from './core/loop.js';
import { maybeCompactContext } from './context/index.js';
import { BuiltinToolsMap } from './tools/index.js';
import { PluginManager } from './plugin/PluginManager.js';
import { builtInMCPPlugin, builtInPlanModePlugin, builtInTaskTrackingPlugin, SubAgentPlugin, createBuiltInSkillsPlugin } from './built-in/index.js';

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
   * Backward-compatible shorthand — internally converted to
   * beforeToolCall / afterToolCall engine hooks.
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

  /**
   * 远程 skill 配置。
   * 提供后，engine 初始化时会通过 HTTP GET 拉取指定 endpoint 的 skill 列表，
   * 与本地 SKILL.md 文件合并（本地同名 skill 优先）。
   *
   * 远程 endpoint 需返回以下格式的 JSON：
   * {
   *   "skills": [
   *     {
   *       "name": "string",
   *       "description": "string",
   *       "content": "string",   // skill 正文 (Markdown)
   *       "version": "string",   // 可选
   *       "author": "string"     // 可选
   *     }
   *   ]
   * }
   *
   * @example 单个 endpoint
   * const engine = new Engine({
   *   remoteSkills: {
   *     endpoints: 'https://skills.example.com/api/skills',
   *   }
   * });
   *
   * @example 多个 endpoint，带鉴权头和超时
   * const engine = new Engine({
   *   remoteSkills: {
   *     endpoints: [
   *       'https://internal.example.com/api/skills',
   *       'https://public.example.com/api/skills',
   *     ],
   *     headers: { Authorization: 'Bearer <token>' },
   *     timeout: 8000,
   *   }
   * });
   */
  remoteSkills?: RemoteSkillConfig;
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

    // 内置插件列表：skills 插件通过工厂创建，以便传入远程 skill 配置
    const builtInPluginList = [
      builtInMCPPlugin,
      createBuiltInSkillsPlugin({ remoteSkills: this.options.remoteSkills }),
      builtInPlanModePlugin,
      builtInTaskTrackingPlugin,
      new SubAgentPlugin(),
    ];
    const userPluginList = userPlugins.plugins || [];

    return {
      plugins: [...builtInPluginList, ...userPluginList],
      dirs: userPlugins.dirs || ['.pulse-coder/engine-plugins', '.coder/engine-plugins', '~/.pulse-coder/engine-plugins', '~/.coder/engine-plugins'],
      scan: userPlugins.scan !== false // 默认启用扫描
    };
  }

  /**
   * Collect all hooks for a given loop invocation.
   * Merges plugin hooks with the legacy EngineOptions.hooks (ToolHooks).
   */
  private collectLoopHooks(): LoopHooks {
    const loopHooks: LoopHooks = {
      beforeLLMCall: this.pluginManager.getHooks('beforeLLMCall'),
      afterLLMCall: this.pluginManager.getHooks('afterLLMCall'),
      beforeToolCall: [...this.pluginManager.getHooks('beforeToolCall')],
      afterToolCall: [...this.pluginManager.getHooks('afterToolCall')],
    };

    // Convert legacy EngineOptions.hooks (ToolHooks) to hook entries
    const legacyHooks = this.options.hooks;
    if (legacyHooks?.onBeforeToolCall) {
      const legacyBefore = legacyHooks.onBeforeToolCall;
      loopHooks.beforeToolCall!.push(async ({ name, input }) => {
        const modified = await legacyBefore(name, input);
        return modified !== undefined ? { input: modified } : undefined;
      });
    }
    if (legacyHooks?.onAfterToolCall) {
      const legacyAfter = legacyHooks.onAfterToolCall;
      loopHooks.afterToolCall!.push(async ({ name, input, output }) => {
        const modified = await legacyAfter(name, input, output);
        return modified !== undefined ? { output: modified } : undefined;
      });
    }

    return loopHooks;
  }

  /**
   * 运行AI循环
   */
  async run(context: Context, options?: LoopOptions): Promise<string> {
    let systemPrompt = options?.systemPrompt ?? this.options.systemPrompt;
    let tools = { ...this.tools };

    // --- beforeRun hooks ---
    const beforeRunHooks = this.pluginManager.getHooks('beforeRun');
    for (const hook of beforeRunHooks) {
      const result = await hook({ context, systemPrompt, tools });
      if (result) {
        if ('systemPrompt' in result && result.systemPrompt !== undefined) {
          systemPrompt = result.systemPrompt;
        }
        if ('tools' in result && result.tools !== undefined) {
          tools = result.tools;
        }
      }
    }

    // Collect all hook arrays for the loop
    const loopHooks = this.collectLoopHooks();

    const resultText = await loop(context, {
      ...options,
      tools,
      provider: options?.provider ?? this.options.llmProvider,
      model: options?.model ?? this.options.model,
      systemPrompt,
      hooks: loopHooks,
      onToolCall: (toolCall) => {
        options?.onToolCall?.(toolCall);
      },
      onClarificationRequest: options?.onClarificationRequest,
    });

    // --- afterRun hooks ---
    const afterRunHooks = this.pluginManager.getHooks('afterRun');
    for (const hook of afterRunHooks) {
      await hook({ context, result: resultText });
    }

    return resultText;
  }

  /**
   * 手动触发上下文压缩
   * 默认复用 Engine 初始化时配置的 provider/model
   */
  async compactContext(
    context: Context,
    options?: { force?: boolean; provider?: LLMProviderFactory; model?: string }
  ): Promise<{ didCompact: boolean; reason?: string; newMessages?: Context['messages'] }> {
    return await maybeCompactContext(context, {
      force: options?.force,
      provider: options?.provider ?? this.options.llmProvider,
      model: options?.model ?? this.options.model,
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
   * 获取 plan mode 服务
   */
  private getPlanModeService(): PlanModeService | undefined {
    return this.getService<PlanModeService>('planMode') ?? this.getService<PlanModeService>('planModeService');
  }

  /**
   * 获取当前模式
   */
  getMode(): PlanMode | undefined {
    return this.getPlanModeService()?.getMode();
  }

  /**
   * 设置当前模式
   */
  setMode(mode: PlanMode, reason: string = 'manual'): boolean {
    const planModeService = this.getPlanModeService();
    if (!planModeService) {
      return false;
    }

    planModeService.setMode(mode, reason);
    return true;
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
export type { LoopOptions, LoopHooks, CompactionEvent } from './core/loop.js';
export { streamTextAI } from './ai/index.js';
export { maybeCompactContext } from './context/index.js';
export * from './tools/index.js';
export type { RemoteSkillConfig, BuiltInSkillsPluginOptions } from './built-in/skills-plugin/index.js';
export { createBuiltInSkillsPlugin } from './built-in/index.js';

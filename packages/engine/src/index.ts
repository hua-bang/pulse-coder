export { Engine } from './Engine.js';

// 插件系统导出
export type { EnginePlugin, EnginePluginContext } from './plugin/EnginePlugin.js';
export type { UserConfigPlugin, UserConfigPluginLoadOptions } from './plugin/UserConfigPlugin.js';
export { PluginManager } from './plugin/PluginManager.js';

// 内置插件导出
export { builtInPlugins, builtInMCPPlugin, builtInSkillsPlugin, BuiltInSkillRegistry } from './built-in/index.js';

// 原有导出保持不变
export * from './shared/types.js';
export { loop } from './core/loop.js';
export { streamTextAI } from './ai/index.js';
export { maybeCompactContext } from './context/index.js';
export * from './tools/index.js';
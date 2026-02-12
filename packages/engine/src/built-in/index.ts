/**
 * Built-in plugins for Coder Engine
 * 引擎内置插件集合
 */

import { builtInMCPPlugin } from './mcp-plugin';
import { builtInSkillsPlugin } from './skills-plugin';

/**
 * 默认内置插件列表
 * 这些插件会在引擎启动时自动加载
 */
export const builtInPlugins = [
  builtInMCPPlugin,
  builtInSkillsPlugin
];

/**
 * 单独导出各个内置插件，便于外部使用
 */
export { builtInMCPPlugin } from './mcp-plugin';
export { builtInSkillsPlugin, BuiltInSkillRegistry } from './skills-plugin';

export default builtInPlugins;
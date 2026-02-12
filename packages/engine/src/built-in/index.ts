/**
 * Built-in plugins for Coder Engine
 * 引擎内置插件集合
 */

import { builtInMCPPlugin } from './mcp-plugin';
import { builtInSkillsPlugin } from './skills-plugin';
import { SubAgentPlugin } from './sub-agent-plugin';

/**
 * 默认内置插件列表
 * 这些插件会在引擎启动时自动加载
 */
export const builtInPlugins = [
  builtInMCPPlugin,
  builtInSkillsPlugin,
  new SubAgentPlugin()
];

/**
 * 单独导出各个内置插件，便于外部使用
 */
export { builtInMCPPlugin } from './mcp-plugin';
export { builtInSkillsPlugin, BuiltInSkillRegistry } from './skills-plugin';
export { SubAgentPlugin } from './sub-agent-plugin';

export default builtInPlugins;
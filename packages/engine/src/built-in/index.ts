/**
 * Built-in plugins for Pulse Coder Engine
 * 引擎内置插件集合
 */

import { builtInMCPPlugin } from './mcp-plugin';
import { builtInSkillsPlugin } from './skills-plugin';
import { builtInPlanModePlugin } from './plan-mode-plugin';
import { builtInTaskTrackingPlugin } from './task-tracking-plugin';
import { SubAgentPlugin } from './sub-agent-plugin';

/**
 * 默认内置插件列表
 * 这些插件会在引擎启动时自动加载
 */
export const builtInPlugins = [
  builtInMCPPlugin,
  builtInSkillsPlugin,
  builtInPlanModePlugin,
  builtInTaskTrackingPlugin,
  new SubAgentPlugin()
];

/**
 * 单独导出各个内置插件，便于外部使用
 */
export { builtInMCPPlugin } from './mcp-plugin';
export {
  builtInSkillsPlugin,
  createBuiltInSkillsPlugin,
  BuiltInSkillRegistry,
} from './skills-plugin';
export type {
  RemoteSkillConfig,
  BuiltInSkillsPluginOptions,
} from './skills-plugin';
export { builtInPlanModePlugin, BuiltInPlanModeService } from './plan-mode-plugin';
export { builtInTaskTrackingPlugin, TaskListService } from './task-tracking-plugin';
export type { TaskStatus, WorkTask, WorkTaskListSnapshot } from './task-tracking-plugin';
export type {
  PlanMode,
  PlanIntentLabel,
  ToolCategory,
  ToolRisk,
  ToolMeta,
  ModePolicy,
  PlanModeEvent,
  PlanModeEventName,
  PlanModeTransitionResult,
  PlanModeService
} from './plan-mode-plugin';
export { SubAgentPlugin } from './sub-agent-plugin';

export default builtInPlugins;
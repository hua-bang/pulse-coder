/**
 * Built-in plugins for Pulse Coder Engine
 * Engine built-in plugin registry
 */

import { createAcpPlugin } from 'pulse-coder-acp';
import type { EnginePlugin } from '../plugin/EnginePlugin';
import { builtInMCPPlugin } from './mcp-plugin';
import { builtInSkillsPlugin } from './skills-plugin';
import { builtInPlanModePlugin } from './plan-mode-plugin';
import { builtInToolSearchPlugin } from './tool-search-plugin';
import { builtInTaskTrackingPlugin } from './task-tracking-plugin';
import { builtInRoleSoulPlugin } from './role-soul-plugin';
import { SubAgentPlugin } from './sub-agent-plugin';
import { builtInAgentTeamsPlugin } from './agent-teams-plugin';
import { builtInPtcPlugin } from './ptc-plugin';

const acpPluginInstance: EnginePlugin = createAcpPlugin() as EnginePlugin;

/**
 * Default built-in plugins.
 */
export const builtInPlugins: EnginePlugin[] = [
  acpPluginInstance,
  builtInMCPPlugin,
  builtInSkillsPlugin,
  builtInToolSearchPlugin,
  builtInPlanModePlugin,
  builtInTaskTrackingPlugin,
  new SubAgentPlugin(),
  builtInAgentTeamsPlugin,
  builtInRoleSoulPlugin,
  builtInPtcPlugin,
];

/**
 * Export built-in plugins individually.
 */
export { createAcpPlugin } from 'pulse-coder-acp';
export const builtInAcpPlugin: EnginePlugin = acpPluginInstance;
export { builtInMCPPlugin } from './mcp-plugin';
export { builtInSkillsPlugin, BuiltInSkillRegistry } from './skills-plugin';
export { builtInPlanModePlugin, BuiltInPlanModeService } from './plan-mode-plugin';
export { builtInToolSearchPlugin } from './tool-search-plugin';
export { builtInTaskTrackingPlugin, TaskListService } from './task-tracking-plugin';
export type { TaskStatus, WorkTask, WorkTaskListSnapshot } from './task-tracking-plugin';
export { builtInAgentTeamsPlugin } from './agent-teams-plugin';
export { builtInRoleSoulPlugin } from './role-soul-plugin';
export { builtInPtcPlugin } from './ptc-plugin';
export type { TeamRole, TaskGraph, TaskNode, NodeResult, TeamRunInput, TeamRunOutput } from './agent-teams-plugin/types';
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

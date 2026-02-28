export { Engine } from './Engine.js';
export { Engine as PulseAgent } from './Engine.js'; // 添加 PulseAgent 别名

// 插件系统导出
export type {
  EnginePlugin,
  EnginePluginContext,
  EngineHookMap,
  EngineHookName,
  BeforeRunInput,
  BeforeRunResult,
  BeforeLLMCallInput,
  BeforeLLMCallResult,
  AfterRunInput,
  AfterLLMCallInput,
  BeforeToolCallInput,
  BeforeToolCallResult,
  AfterToolCallInput,
  AfterToolCallResult,
  OnCompactedEvent,
  OnCompactedInput,
} from './plugin/EnginePlugin.js';
export type { UserConfigPlugin, UserConfigPluginLoadOptions } from './plugin/UserConfigPlugin.js';
export { PluginManager } from './plugin/PluginManager.js';

// 内置插件导出
export {
  builtInPlugins,
  builtInMCPPlugin,
  builtInSkillsPlugin,
  builtInPlanModePlugin,
  builtInTaskTrackingPlugin,
  builtInAgentTeamPlugin,
  BuiltInSkillRegistry,
  BuiltInPlanModeService,
  TaskListService,
} from './built-in/index.js';
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
  PlanModeService,
  TaskStatus,
  WorkTask,
  WorkTaskListSnapshot
} from './built-in/index.js';

// 原有导出保持不变
export * from './shared/types.js';
export { loop } from './core/loop.js';
export type { LoopOptions, LoopHooks, CompactionEvent } from './core/loop.js';
export { streamTextAI } from './ai/index.js';
export { maybeCompactContext } from './context/index.js';
export * from './tools/index.js';
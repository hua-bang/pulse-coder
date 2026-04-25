// Core classes
export { Team } from './team.js';
export { TeamLead } from './team-lead.js';
export type { TeamLeadOptions } from './team-lead.js';
export { Teammate } from './teammate.js';
export { Mailbox } from './mailbox.js';
export { TaskList } from './task-list.js';

// Planner
export { planTeam, buildTeammateOptionsFromPlan } from './planner.js';
export type { PlannerOptions, TeamPlan } from './planner.js';

// Display
export { InProcessDisplay } from './display/in-process.js';

// Runtimes
export {
  PulseRuntime,
  ClaudeCodeRuntime,
  type AgentRuntime,
  type AgentRuntimeKind,
  type AgentRuntimeFactory,
  type RuntimeContext,
  type RuntimeRunOptions,
  type PulseRuntimeOptions,
  type ClaudeCodeRuntimeOptions,
} from './runtimes/index.js';

// Team-tool surface (used by mailbox-MCP and pulse runtime)
export {
  TEAM_TOOL_SCHEMAS,
  callTeamTool,
  createPulseTeamTools,
  type TeamToolContext,
  type MailboxToolJsonSchema,
} from './team-tools.js';

// Mailbox MCP server entry (for embedding into apps that need a custom launcher)
export {
  runMailboxMcpServer,
  dispatchMailboxRpc,
  type MailboxMcpServerOptions,
} from './mcp/mailbox-mcp-server.js';

// Types
export type {
  EngineOptions,
  TeamConfig,
  TeamStatus,
  TeamMemberInfo,
  PersistedTeamConfig,
  TeammateOptions,
  TeammateStatus,
  Task,
  CreateTaskInput,
  TaskStatus,
  TeamMessage,
  MessageType,
  TeamHooks,
  TeamEvent,
  TeamEventType,
  TeamEventHandler,
  DisplayMode,
} from './types.js';

import { homedir } from 'os';
import { join } from 'path';
import {
  createMemoryIntegrationFromEnv,
  type MemoryIntegration,
  type MemoryRunContext,
} from 'pulse-coder-memory-plugin';

const CANVAS_MEMORY_PLUGIN_NAME = 'canvas-workspace-memory';

/**
 * Workspace-local memory lives alongside the workspace's canvas.json,
 * notes, images, artifacts, and agent sessions. This keeps the initial
 * Canvas memory rollout isolated per workspace without moving any existing
 * Canvas storage paths.
 */
export function getCanvasWorkspaceMemoryDir(workspaceId: string): string {
  return join(homedir(), '.pulse-coder', 'canvas', workspaceId, 'memory');
}

/**
 * Reserved for a future global Canvas memory layer shared across workspaces.
 * The MVP intentionally does not use this path yet.
 */
export function getCanvasGlobalMemoryDir(): string {
  return join(homedir(), '.pulse-coder', 'canvas', 'memory');
}

export function createCanvasWorkspaceMemoryIntegration(workspaceId: string): MemoryIntegration {
  return createMemoryIntegrationFromEnv({
    baseDir: getCanvasWorkspaceMemoryDir(workspaceId),
    pluginName: CANVAS_MEMORY_PLUGIN_NAME,
  });
}

export function createCanvasWorkspaceMemoryRunContext(input: {
  workspaceId: string;
  userText: string;
}): MemoryRunContext {
  return {
    platformKey: `canvas-workspace:${input.workspaceId}`,
    // memory-plugin has session/user scopes but no native workspace scope.
    // Using the workspace id as the memory session id makes session-scoped
    // memories behave as workspace-scoped memories for Canvas.
    sessionId: input.workspaceId,
    userText: input.userText,
  };
}

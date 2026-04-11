import type { MouseEvent } from 'react';
import type { AgentSessionInfo, CanvasNode } from '../../types';

export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface ChatPanelProps {
  workspaceId: string;
  allWorkspaces?: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  onClose: () => void;
  onResizeStart?: (e: MouseEvent) => void;
  onNodeFocus?: (nodeId: string) => void;
}

export interface OtherWorkspaceSession extends AgentSessionInfo {
  sourceWorkspaceId: string;
  workspaceName: string;
}

export interface ToolCallStatus {
  id: number;
  name: string;
  args?: any;
  status: 'running' | 'done';
  result?: string;
}

export interface MentionItem {
  type: 'node' | 'file' | 'workspace';
  label: string;
  nodeType?: CanvasNode['type'];
  path?: string;
  workspaceId?: string;
}

export interface PendingClarification {
  id: string;
  question: string;
  context?: string;
}

export interface QuickAction {
  key: 'overview' | 'note' | 'summarize' | 'command';
  label: string;
  prompt: string;
}

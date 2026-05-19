import { useState } from 'react';
import type { AgentRequestContext, CanvasNode } from '../../../types';
import { useCanvasModels } from '../ModelSettings';
import { usePromptProfile } from '../PromptSettings';
import type { WorkspaceOption } from '../types';
import { useChatSessions } from './useChatSessions';
import { useChatStream } from './useChatStream';
import { useMentions } from './useMentions';

interface UseChatComposerStateOptions {
  workspaceId: string;
  allWorkspaces?: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  /** Forwarded to useChatSessions — load the session list on mount + workspace change. */
  eagerLoad?: boolean;
  /** Forwarded to useChatSessions — skip the initial getHistory call. */
  skipInitialHistory?: boolean;
  /** Forwarded to useMentions — lets callers thread per-submit request context (selected nodes, executionMode, …). */
  getRequestContext?: () => AgentRequestContext | undefined;
}

/**
 * Wires up the shared chat-surface state (streaming, sessions, mentions,
 * model picker, prompt profile, drawer state) used by both the right-side
 * ChatPanel and the full-screen ChatPage. Each caller renders its own
 * layout chrome (resize handle / session rail / header) around the
 * returned state.
 */
export function useChatComposerState({
  workspaceId,
  allWorkspaces,
  nodes,
  rootFolder,
  eagerLoad,
  skipInitialHistory,
  getRequestContext,
}: UseChatComposerStateOptions) {
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [promptSettingsOpen, setPromptSettingsOpen] = useState(false);
  const canvasModels = useCanvasModels();
  const promptProfile = usePromptProfile();

  const chatStream = useChatStream({ workspaceId, allWorkspaces });

  const chatSessions = useChatSessions({
    workspaceId,
    allWorkspaces,
    onMessagesLoaded: chatStream.replaceMessages,
    eagerLoad,
    skipInitialHistory,
  });

  const mentions = useMentions({
    allWorkspaces,
    workspaceId,
    nodes,
    rootFolder,
    onSubmit: chatStream.sendMessage,
    getRequestContext,
  });

  return {
    ...chatStream,
    ...chatSessions,
    ...mentions,
    canvasModels,
    promptProfile,
    modelSettingsOpen,
    setModelSettingsOpen,
    promptSettingsOpen,
    setPromptSettingsOpen,
  };
}

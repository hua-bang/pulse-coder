import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentChatMessage } from '../../../types';
import type { PendingClarification, ToolCallStatus, WorkspaceOption } from '../types';
import { extractMentionedWorkspaceIds } from '../utils/mentions';

interface UseChatStreamOptions {
  workspaceId: string;
  allWorkspaces?: WorkspaceOption[];
}

export function useChatStream({ workspaceId, allWorkspaces }: UseChatStreamOptions) {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingTools, setStreamingTools] = useState<ToolCallStatus[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [messageTools, setMessageTools] = useState<Map<number, ToolCallStatus[]>>(new Map());
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingClarify, setPendingClarify] = useState<PendingClarification | null>(null);
  const [clarifyInput, setClarifyInput] = useState('');
  const toolIdCounter = useRef(0);
  const activeUnsubsRef = useRef<(() => void)[]>([]);
  const streamingMsgIdx = useRef(-1);

  const cleanupSubscriptions = useCallback(() => {
    for (const unsubscribe of activeUnsubsRef.current) {
      unsubscribe();
    }
    activeUnsubsRef.current = [];
  }, []);

  useEffect(() => {
    setActiveSessionId(null);
    setPendingClarify(null);
    setClarifyInput('');

    return cleanupSubscriptions;
  }, [cleanupSubscriptions, workspaceId]);

  const replaceMessages = useCallback((nextMessages: AgentChatMessage[]) => {
    setMessages(nextMessages);
    setMessageTools(new Map());
    setCollapsedSections(new Set());
  }, []);

  const sendMessage = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || loading) return false;

    const userMessage: AgentChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    try {
      const mentionedWorkspaceIds = extractMentionedWorkspaceIds(text, allWorkspaces, workspaceId);
      const result = await window.canvasWorkspace.agent.chat(
        workspaceId,
        text,
        mentionedWorkspaceIds.length > 0 ? mentionedWorkspaceIds : undefined,
      );

      if (!result.ok || !result.sessionId) {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: `Error: ${result.error ?? 'Failed to start chat'}`,
            timestamp: Date.now(),
          },
        ]);
        setLoading(false);
        return false;
      }

      const sessionId = result.sessionId;
      const assistantIndex = { current: -1 };
      const toolCalls: ToolCallStatus[] = [];
      setActiveSessionId(sessionId);

      const ensureAssistantMessage = () => {
        if (assistantIndex.current >= 0) return;
        setMessages(prev => {
          if (assistantIndex.current >= 0) return prev;
          assistantIndex.current = prev.length;
          streamingMsgIdx.current = prev.length;
          return [...prev, { role: 'assistant', content: '', timestamp: Date.now() }];
        });
      };

      const cleanupTurn = () => {
        unsubscribeDelta();
        unsubscribeComplete();
        unsubscribeToolCall();
        unsubscribeToolResult();
        unsubscribeClarify();
        activeUnsubsRef.current = [];
      };

      const unsubscribeToolCall = window.canvasWorkspace.agent.onToolCall(sessionId, data => {
        ensureAssistantMessage();
        toolCalls.push({
          id: ++toolIdCounter.current,
          name: data.name,
          args: data.args,
          status: 'running',
        });
        const snapshot = [...toolCalls];
        setStreamingTools(snapshot);
        if (assistantIndex.current >= 0) {
          setMessageTools(prev => new Map(prev).set(assistantIndex.current, snapshot));
        }
      });

      const unsubscribeToolResult = window.canvasWorkspace.agent.onToolResult(sessionId, data => {
        const toolCall = toolCalls.find(item => item.name === data.name && item.status === 'running');
        if (toolCall) {
          toolCall.status = 'done';
          toolCall.result = data.result;
        }

        const snapshot = [...toolCalls];
        setStreamingTools(snapshot);
        if (assistantIndex.current >= 0) {
          setMessageTools(prev => new Map(prev).set(assistantIndex.current, snapshot));
        }
      });

      const unsubscribeDelta = window.canvasWorkspace.agent.onTextDelta(sessionId, delta => {
        ensureAssistantMessage();
        setMessages(prev => {
          const index = assistantIndex.current;
          if (index < 0 || index >= prev.length) return prev;
          const next = [...prev];
          next[index] = { ...next[index], content: next[index].content + delta };
          return next;
        });
      });

      const unsubscribeClarify = window.canvasWorkspace.agent.onClarifyRequest(sessionId, request => {
        ensureAssistantMessage();
        setPendingClarify({ id: request.id, question: request.question, context: request.context });
        setClarifyInput('');
      });

      const unsubscribeComplete = window.canvasWorkspace.agent.onChatComplete(sessionId, completeResult => {
        cleanupTurn();
        if (assistantIndex.current >= 0 && toolCalls.length > 0) {
          setCollapsedSections(prev => new Set(prev).add(assistantIndex.current));
        }

        setStreamingTools([]);
        setExpandedTools(new Set());
        streamingMsgIdx.current = -1;
        setActiveSessionId(null);
        setPendingClarify(null);
        setClarifyInput('');

        if (!completeResult.ok) {
          setMessages(prev => {
            if (assistantIndex.current < 0) {
              return [
                ...prev,
                {
                  role: 'assistant',
                  content: `Error: ${completeResult.error ?? 'Unknown error'}`,
                  timestamp: Date.now(),
                },
              ];
            }

            const next = [...prev];
            const index = assistantIndex.current;
            const existingContent = next[index]?.content;
            next[index] = {
              ...next[index],
              content: existingContent || `Error: ${completeResult.error ?? 'Unknown error'}`,
            };
            return next;
          });
        } else if (completeResult.response) {
          setMessages(prev => {
            if (assistantIndex.current < 0) {
              return [
                ...prev,
                {
                  role: 'assistant',
                  content: completeResult.response ?? '',
                  timestamp: Date.now(),
                },
              ];
            }

            const next = [...prev];
            next[assistantIndex.current] = {
              ...next[assistantIndex.current],
              content: completeResult.response ?? '',
            };
            return next;
          });
        }

        setLoading(false);
      });

      activeUnsubsRef.current.push(
        unsubscribeToolCall,
        unsubscribeToolResult,
        unsubscribeDelta,
        unsubscribeComplete,
        unsubscribeClarify,
      );

      return true;
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${String(error)}`,
          timestamp: Date.now(),
        },
      ]);
      setLoading(false);
      setActiveSessionId(null);
      setPendingClarify(null);
      setClarifyInput('');
      return false;
    }
  }, [allWorkspaces, loading, workspaceId]);

  const abort = useCallback(async () => {
    const sessionId = activeSessionId;
    if (!sessionId) return;

    setPendingClarify(null);
    setClarifyInput('');

    try {
      await window.canvasWorkspace.agent.abort(sessionId);
    } catch (error) {
      console.error('[chat-panel] abort failed:', error);
    }
  }, [activeSessionId]);

  const answerClarification = useCallback(async () => {
    const pending = pendingClarify;
    const sessionId = activeSessionId;
    if (!pending || !sessionId) return;

    const answer = clarifyInput.trim();
    if (!answer) return;

    setPendingClarify(null);
    setClarifyInput('');

    try {
      await window.canvasWorkspace.agent.answerClarification(sessionId, pending.id, answer);
    } catch (error) {
      console.error('[chat-panel] clarification answer failed:', error);
    }
  }, [activeSessionId, clarifyInput, pendingClarify]);

  const toggleSection = useCallback((messageIndex: number) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(messageIndex)) next.delete(messageIndex);
      else next.add(messageIndex);
      return next;
    });
  }, []);

  const toggleToolExpand = useCallback((toolId: number) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }, []);

  return {
    abort,
    answerClarification,
    clarifyInput,
    collapsedSections,
    expandedTools,
    loading,
    messageTools,
    messages,
    pendingClarify,
    replaceMessages,
    sendMessage,
    setClarifyInput,
    streamingTools,
    toggleSection,
    toggleToolExpand,
  };
}

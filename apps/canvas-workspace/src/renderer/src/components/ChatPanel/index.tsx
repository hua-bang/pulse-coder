import { useState, useRef, useEffect, useCallback } from 'react';
import MarkdownIt from 'markdown-it';
import type { AgentChatMessage, AgentSessionInfo } from '../../types';
import './ChatPanel.css';

interface ChatPanelProps {
  workspaceId: string;
  onClose: () => void;
  onResizeStart?: (e: React.MouseEvent) => void;
}

const QUICK_ACTIONS = [
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
    label: 'What\u2019s on the canvas?',
    prompt: 'What\u2019s on the canvas? Give me an overview.',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 8h4M8 6v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
    label: 'Create a new note',
    prompt: 'Create a new note on the canvas.',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
    label: 'Summarize my notes',
    prompt: 'Summarize all the notes on my canvas.',
  },
  {
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 6l2.5 2L4 10M8 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="1.5" y="2" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
    label: 'Run a command',
    prompt: '',
  },
];

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export const ChatPanel = ({ workspaceId, onClose, onResizeStart }: ChatPanelProps) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  // Load history on mount
  useEffect(() => {
    void (async () => {
      const result = await window.canvasWorkspace.agent.getHistory(workspaceId);
      if (result.ok && result.messages) {
        setMessages(result.messages);
      }
    })();
  }, [workspaceId]);

  // Close session menu on outside click
  useEffect(() => {
    if (!sessionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
        setSessionMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sessionMenuOpen]);

  // Load sessions list when menu opens
  const openSessionMenu = useCallback(async () => {
    if (sessionMenuOpen) {
      setSessionMenuOpen(false);
      return;
    }
    const result = await window.canvasWorkspace.agent.listSessions(workspaceId);
    if (result.ok && result.sessions) {
      setSessions(result.sessions);
    }
    setSessionMenuOpen(true);
  }, [sessionMenuOpen, workspaceId]);

  const handleNewSession = useCallback(async () => {
    setSessionMenuOpen(false);
    await window.canvasWorkspace.agent.newSession(workspaceId);
    setMessages([]);
  }, [workspaceId]);

  const handleLoadSession = useCallback(async (sessionId: string) => {
    setSessionMenuOpen(false);
    const result = await window.canvasWorkspace.agent.loadSession(workspaceId, sessionId);
    if (result.ok && result.messages) {
      setMessages(result.messages);
    }
  }, [workspaceId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    const userMsg: AgentChatMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const result = await window.canvasWorkspace.agent.chat(workspaceId, text);
      if (!result.ok || !result.sessionId) {
        const errorMsg: AgentChatMessage = {
          role: 'assistant',
          content: `Error: ${result.error ?? 'Failed to start chat'}`,
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, errorMsg]);
        setLoading(false);
        return;
      }

      const sessionId = result.sessionId;

      // Lazily create assistant message on first text delta
      const assistantIdx = { current: -1 };

      // Subscribe to text deltas
      const unsubDelta = window.canvasWorkspace.agent.onTextDelta(sessionId, (delta) => {
        setMessages(prev => {
          if (assistantIdx.current < 0) {
            // First delta — create the assistant message now
            assistantIdx.current = prev.length;
            return [...prev, { role: 'assistant' as const, content: delta, timestamp: Date.now() }];
          }
          const idx = assistantIdx.current;
          if (idx >= prev.length) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: updated[idx].content + delta };
          return updated;
        });
      });

      // Subscribe to completion
      const unsubComplete = window.canvasWorkspace.agent.onChatComplete(sessionId, (completeResult) => {
        unsubDelta();
        unsubComplete();

        if (!completeResult.ok) {
          setMessages(prev => {
            if (assistantIdx.current < 0) {
              return [...prev, { role: 'assistant' as const, content: `Error: ${completeResult.error ?? 'Unknown error'}`, timestamp: Date.now() }];
            }
            const idx = assistantIdx.current;
            const updated = [...prev];
            const existing = updated[idx]?.content;
            updated[idx] = { ...updated[idx], content: existing || `Error: ${completeResult.error ?? 'Unknown error'}` };
            return updated;
          });
        } else if (completeResult.response) {
          setMessages(prev => {
            if (assistantIdx.current < 0) {
              // No deltas arrived — add complete message directly
              return [...prev, { role: 'assistant' as const, content: completeResult.response!, timestamp: Date.now() }];
            }
            const idx = assistantIdx.current;
            const updated = [...prev];
            updated[idx] = { ...updated[idx], content: completeResult.response! };
            return updated;
          });
        }

        setLoading(false);
      });
    } catch (err) {
      const errorMsg: AgentChatMessage = {
        role: 'assistant',
        content: `Error: ${String(err)}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMsg]);
      setLoading(false);
    }
  }, [input, loading, workspaceId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }, [sendMessage]);

  const handleQuickAction = useCallback((prompt: string) => {
    if (prompt) {
      void sendMessage(prompt);
    } else {
      textareaRef.current?.focus();
    }
  }, [sendMessage]);

  const hasMessages = messages.length > 0 || loading;

  return (
    <div className="chat-panel">
      {onResizeStart && (
        <div className="chat-panel-resize" onMouseDown={onResizeStart} />
      )}
      <div className="chat-panel-header">
        <div className="chat-panel-title-wrapper" ref={sessionMenuRef}>
          <button className="chat-panel-title-btn" onClick={() => void openSessionMenu()}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4 14c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span>Pulse Agent</span>
            <svg className="chat-panel-title-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {sessionMenuOpen && (
            <div className="chat-session-menu">
              <button className="chat-session-menu-new" onClick={() => void handleNewSession()}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span>New chat</span>
              </button>
              {sessions.length > 0 && (
                <>
                  <div className="chat-session-menu-divider" />
                  <div className="chat-session-menu-label">Recent</div>
                  <div className="chat-session-menu-list">
                    {sessions.map((s) => (
                      <button
                        key={s.sessionId}
                        className={`chat-session-menu-item${s.isCurrent ? ' chat-session-menu-item--active' : ''}`}
                        onClick={() => {
                          if (!s.isCurrent) void handleLoadSession(s.sessionId);
                          else setSessionMenuOpen(false);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <path d="M4 3.5h6M4 7h4M4 10.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                        <span className="chat-session-menu-item-text">
                          {s.isCurrent ? 'Current chat' : s.date}
                        </span>
                        <span className="chat-session-menu-item-count">{s.messageCount} msgs</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="chat-panel-actions">
          <button
            className="chat-panel-action-btn"
            onClick={() => void handleNewSession()}
            title="New chat"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button className="chat-panel-action-btn" onClick={onClose} title="Close panel">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {!hasMessages ? (
        <div className="chat-empty-state">
          <div className="chat-empty-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="12" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 28c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="13.5" cy="11" r="1" fill="currentColor" />
              <circle cx="18.5" cy="11" r="1" fill="currentColor" />
              <path d="M13.5 14c0 0 1 1.5 2.5 1.5s2.5-1.5 2.5-1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </div>
          <div className="chat-empty-greeting">Hi, how can I help?</div>
          <div className="chat-quick-actions">
            {QUICK_ACTIONS.map((action, i) => (
              <button
                key={i}
                className="chat-quick-action"
                onClick={() => handleQuickAction(action.prompt)}
              >
                <span className="chat-quick-action-icon">{action.icon}</span>
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-messages">
          {messages.map((msg, i) => {
            const isStreaming = loading && msg.role === 'assistant' && i === messages.length - 1;
            return (
              <div key={i} className={`chat-message chat-message-${msg.role}`}>
                {msg.role === 'assistant' && (
                  <div className="chat-message-avatar">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M4 14c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <div
                    className={`chat-message-content chat-md${isStreaming ? ' chat-md--streaming' : ''}`}
                    dangerouslySetInnerHTML={{ __html: md.render(msg.content) }}
                  />
                ) : (
                  <div className="chat-message-content">{msg.content}</div>
                )}
              </div>
            );
          })}
          {loading && !(messages.length > 0 && messages[messages.length - 1].role === 'assistant') && (
            <div className="chat-message chat-message-assistant">
              <div className="chat-message-avatar">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M4 14c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </div>
              <div className="chat-loading">
                <div className="chat-loading-dot" />
                <div className="chat-loading-dot" />
                <div className="chat-loading-dot" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="chat-input-container">
        <div className="chat-input-box">
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder="Ask anything..."
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading}
          />
          <div className="chat-input-footer">
            <div className="chat-input-footer-left" />
            <button
              className={`chat-send-btn${input.trim() ? ' chat-send-btn--active' : ''}`}
              onClick={() => void sendMessage()}
              disabled={!input.trim() || loading}
              title="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 12V4M8 4l-3.5 3.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

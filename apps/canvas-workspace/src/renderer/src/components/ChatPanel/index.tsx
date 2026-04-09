import { useState, useRef, useEffect, useCallback } from 'react';
import MarkdownIt from 'markdown-it';
import type { AgentChatMessage, AgentSessionInfo, CanvasNode } from '../../types';
import './ChatPanel.css';

interface ChatPanelProps {
  workspaceId: string;
  nodes?: CanvasNode[];
  rootFolder?: string;
  onClose: () => void;
  onResizeStart?: (e: React.MouseEvent) => void;
  onNodeFocus?: (nodeId: string) => void;
}

interface ToolCallStatus {
  id: number;
  name: string;
  args?: any;
  status: 'running' | 'done';
  result?: string;
}

interface MentionItem {
  type: 'node' | 'file';
  label: string;
  nodeType?: string;
  path?: string;
}

function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function formatToolSignature(name: string, args: any): string {
  if (!args) return `${name}()`;
  const parts: string[] = [];
  if (name === 'read' || name === 'write') {
    if (args.file_path || args.filePath) parts.push(JSON.stringify(args.file_path || args.filePath));
  } else if (name === 'edit') {
    if (args.file_path || args.filePath) parts.push(JSON.stringify(args.file_path || args.filePath));
    if (args.old_string) parts.push(JSON.stringify(truncStr(args.old_string, 30)));
  } else if (name === 'bash') {
    if (args.command) parts.push(JSON.stringify(truncStr(args.command, 60)));
  } else if (name === 'grep') {
    if (args.pattern) parts.push(JSON.stringify(args.pattern));
    if (args.path) parts.push(JSON.stringify(args.path));
  } else if (name === 'ls') {
    if (args.path) parts.push(JSON.stringify(args.path));
  } else {
    for (const v of Object.values(args)) {
      if (parts.length >= 3) break;
      if (typeof v === 'string') parts.push(JSON.stringify(truncStr(v, 40)));
      else if (typeof v === 'number') parts.push(String(v));
    }
  }
  return `${name}(${parts.join(', ')})`;
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

// ─── @ Mention rendering ─────────────────────────────────────────
const MENTION_RE = /@\[([^\]]+)\]/g;

/** SVG icon markup for a given node type (HTML attributes use kebab-case). */
function mentionIconSvg(nodeType: string): string {
  switch (nodeType) {
    case 'terminal':
      return '<rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2 1.5L4 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>';
    case 'agent':
      return '<circle cx="7" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 12c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    case 'frame':
      return '<rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/>';
    default: // file
      return '<rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
  }
}

/** Serialize a contentEditable div back to plain text with @[label] syntax. */
function serializeEditable(el: HTMLElement): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
    } else if (child instanceof HTMLElement) {
      if (child.dataset.mention) {
        text += `@[${child.dataset.mention}]`;
      } else if (child.tagName === 'BR') {
        text += '\n';
      } else {
        text += serializeEditable(child);
      }
    }
  }
  return text;
}

/**
 * Render user message content with structured @[label] mention chips.
 */
function renderUserContent(content: string, nodes?: CanvasNode[]): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE.source, 'g');

  while ((match = re.exec(content)) !== null) {
    // Text before the mention
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    const label = match[1];
    // Try to resolve to a canvas node for type icon
    const node = nodes?.find(n => n.title === label);
    parts.push(
      <span key={match.index} className="chat-mention-chip chat-mention-chip--clickable" data-node-type={node?.type} data-node-id={node?.id}>
        <span className="chat-mention-chip-icon">
          {node?.type === 'terminal' ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4 6l2 1.5L4 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : node?.type === 'agent' ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.5 12c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : node?.type === 'frame' ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="chat-mention-chip-label">{label}</span>
      </span>
    );
    lastIndex = re.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

/**
 * Process markdown HTML to replace @[label] with mention chip markup.
 */
function renderMdWithMentions(content: string, nodes?: CanvasNode[]): string {
  const html = md.render(content);
  return html.replace(MENTION_RE, (_match, label: string) => {
    const node = nodes?.find(n => n.title === label);
    const nodeType = node?.type ?? 'file';
    const nodeId = node?.id ?? '';
    return `<span class="chat-mention-chip chat-mention-chip--clickable" data-node-type="${nodeType}" data-node-id="${nodeId}"><span class="chat-mention-chip-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg(nodeType)}</svg></span><span class="chat-mention-chip-label">${label}</span></span>`;
  });
}

export const ChatPanel = ({ workspaceId, nodes, rootFolder, onClose, onResizeStart, onNodeFocus }: ChatPanelProps) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [streamingTools, setStreamingTools] = useState<ToolCallStatus[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  // Persist tool calls per message (msgIndex → tools). Not stored in message data.
  const [messageTools, setMessageTools] = useState<Map<number, ToolCallStatus[]>>(new Map());
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set());
  const toolIdCounter = useRef(0);
  const streamingMsgIdx = useRef(-1);

  // @ mention state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const filesCacheRef = useRef<MentionItem[] | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);

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
    setMessageTools(new Map());
    setCollapsedSections(new Set());
  }, [workspaceId]);

  const handleLoadSession = useCallback(async (sessionId: string) => {
    setSessionMenuOpen(false);
    const result = await window.canvasWorkspace.agent.loadSession(workspaceId, sessionId);
    if (result.ok && result.messages) {
      setMessages(result.messages);
    }
    setMessageTools(new Map());
    setCollapsedSections(new Set());
  }, [workspaceId]);

  // Scroll to bottom when messages or streaming tools change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingTools]);

  // Build mention items from nodes + files
  const buildMentionItems = useCallback(async (query: string) => {
    const items: MentionItem[] = [];
    // Canvas nodes
    if (nodes) {
      for (const n of nodes) {
        items.push({ type: 'node', label: n.title, nodeType: n.type, path: (n.data as any)?.filePath });
      }
    }
    // Project files (cached)
    if (rootFolder) {
      if (!filesCacheRef.current) {
        try {
          const result = await window.canvasWorkspace.file.listDir(rootFolder, 2);
          if (result.ok && result.entries) {
            const flatFiles: MentionItem[] = [];
            const flatten = (entries: any[], prefix: string) => {
              for (const e of entries) {
                const path = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.type === 'file') {
                  flatFiles.push({ type: 'file', label: path, path: `${rootFolder}/${path}` });
                } else if (e.children) {
                  flatten(e.children, path);
                }
              }
            };
            flatten(result.entries, '');
            filesCacheRef.current = flatFiles;
          }
        } catch {
          filesCacheRef.current = [];
        }
      }
      if (filesCacheRef.current) items.push(...filesCacheRef.current);
    }
    // Filter by query
    const q = query.toLowerCase();
    const filtered = q ? items.filter(it => it.label.toLowerCase().includes(q)) : items;
    return filtered.slice(0, 12);
  }, [nodes, rootFolder]);

  // Handle input in contentEditable + detect @ mention
  const handleInput = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    setInput(serializeEditable(el));

    // Detect @ mention trigger from cursor position
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) {
      setMentionOpen(false);
      return;
    }
    const textBefore = (sel.anchorNode.textContent ?? '').slice(0, sel.anchorOffset);
    const atMatch = textBefore.match(/@([^\s@]*)$/);

    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIndex(0);
      void buildMentionItems(atMatch[1]).then(items => {
        setMentionItems(items);
        setMentionOpen(items.length > 0);
      });
    } else {
      setMentionOpen(false);
    }
  }, [buildMentionItems]);

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

    if (editableRef.current) {
      editableRef.current.innerHTML = '';
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

      // Create assistant message lazily on first event (tool call or text delta)
      const assistantIdx = { current: -1 };
      const toolCalls: ToolCallStatus[] = [];

      const ensureAssistantMessage = () => {
        if (assistantIdx.current >= 0) return;
        setMessages(prev => {
          if (assistantIdx.current >= 0) return prev;
          assistantIdx.current = prev.length;
          streamingMsgIdx.current = prev.length;
          return [...prev, { role: 'assistant' as const, content: '', timestamp: Date.now() }];
        });
      };

      // Subscribe to tool call events
      const unsubToolCall = window.canvasWorkspace.agent.onToolCall(sessionId, (data) => {
        ensureAssistantMessage();
        toolCalls.push({ id: ++toolIdCounter.current, name: data.name, args: data.args, status: 'running' });
        const snapshot = [...toolCalls];
        setStreamingTools(snapshot);
        // Persist to messageTools
        if (assistantIdx.current >= 0) {
          setMessageTools(prev => new Map(prev).set(assistantIdx.current, snapshot));
        }
      });

      const unsubToolResult = window.canvasWorkspace.agent.onToolResult(sessionId, (data) => {
        const tc = toolCalls.find(t => t.name === data.name && t.status === 'running');
        if (tc) {
          tc.status = 'done';
          tc.result = data.result;
        }
        const snapshot = [...toolCalls];
        setStreamingTools(snapshot);
        if (assistantIdx.current >= 0) {
          setMessageTools(prev => new Map(prev).set(assistantIdx.current, snapshot));
        }
      });

      // Subscribe to text deltas
      const unsubDelta = window.canvasWorkspace.agent.onTextDelta(sessionId, (delta) => {
        ensureAssistantMessage();
        setMessages(prev => {
          const idx = assistantIdx.current;
          if (idx < 0 || idx >= prev.length) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: updated[idx].content + delta };
          return updated;
        });
      });

      // Subscribe to completion
      const unsubComplete = window.canvasWorkspace.agent.onChatComplete(sessionId, (completeResult) => {
        unsubDelta();
        unsubComplete();
        unsubToolCall();
        unsubToolResult();
        // Collapse the tool section (don't clear — keep in messageTools)
        if (assistantIdx.current >= 0 && toolCalls.length > 0) {
          setCollapsedSections(prev => new Set(prev).add(assistantIdx.current));
        }
        setStreamingTools([]);
        setExpandedTools(new Set());
        streamingMsgIdx.current = -1;

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

  const selectMention = useCallback((item: MentionItem) => {
    const el = editableRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const { anchorNode, anchorOffset } = sel;
    if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) return;

    const text = anchorNode.textContent ?? '';
    const before = text.slice(0, anchorOffset);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) return;

    const beforeAt = text.slice(0, atIdx);
    const afterCursor = text.slice(anchorOffset);

    // Build chip element with icon + label
    const nodeMatch = nodes?.find(n => n.title === item.label);
    const nodeType = nodeMatch?.type ?? (item.nodeType ?? 'file');
    const chip = document.createElement('span');
    chip.className = 'chat-mention-chip chat-mention-chip--input';
    chip.contentEditable = 'false';
    chip.dataset.mention = item.label;
    chip.dataset.nodeType = nodeType;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'chat-mention-chip-icon';
    iconSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg(nodeType)}</svg>`;
    chip.appendChild(iconSpan);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'chat-mention-chip-label';
    labelSpan.textContent = item.label;
    chip.appendChild(labelSpan);

    // Replace text node with: [beforeText][chip][ ][afterText]
    const parent = anchorNode.parentNode!;
    const frag = document.createDocumentFragment();
    if (beforeAt) frag.appendChild(document.createTextNode(beforeAt));
    frag.appendChild(chip);
    const spaceNode = document.createTextNode(' ');
    frag.appendChild(spaceNode);
    if (afterCursor) frag.appendChild(document.createTextNode(afterCursor));
    parent.replaceChild(frag, anchorNode);

    // Move cursor after space
    const range = document.createRange();
    range.setStartAfter(spaceNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    setInput(serializeEditable(el));
    setMentionOpen(false);
    el.focus();
  }, [nodes]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (mentionOpen && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex(i => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex(i => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionItems[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }, [sendMessage, mentionOpen, mentionItems, mentionIndex, selectMention]);

  const toggleToolExpand = useCallback((id: number) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSection = useCallback((msgIdx: number) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(msgIdx)) next.delete(msgIdx);
      else next.add(msgIdx);
      return next;
    });
  }, []);

  const renderToolCalls = (tools: ToolCallStatus[], msgIdx: number, collapsed: boolean) => {
    if (collapsed) {
      return (
        <div className="chat-tool-calls chat-tool-calls--collapsed" onClick={() => toggleSection(msgIdx)}>
          <span className="chat-tool-call-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="chat-tool-calls-summary">{tools.length} tool call{tools.length > 1 ? 's' : ''}</span>
          <span className="chat-tool-call-chevron">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      );
    }
    return (
      <div className="chat-tool-calls">
        {!loading && tools.length > 0 && (
          <div className="chat-tool-calls-section-header" onClick={() => toggleSection(msgIdx)}>
            <span className="chat-tool-calls-summary">{tools.length} tool call{tools.length > 1 ? 's' : ''}</span>
            <span className="chat-tool-call-chevron chat-tool-call-chevron--open">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        )}
        {tools.map((tc) => (
          <div key={tc.id} className={`chat-tool-call chat-tool-call--${tc.status}`}>
            <div
              className="chat-tool-call-header"
              onClick={tc.status === 'done' && tc.result ? () => toggleToolExpand(tc.id) : undefined}
              style={tc.status === 'done' && tc.result ? { cursor: 'pointer' } : undefined}
            >
              <span className="chat-tool-call-icon">
                {tc.status === 'running' ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="chat-tool-call-spinner">
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="14 14" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="chat-tool-call-sig">{formatToolSignature(tc.name, tc.args)}</span>
              {tc.status === 'done' && tc.result && (
                <span className={`chat-tool-call-chevron${expandedTools.has(tc.id) ? ' chat-tool-call-chevron--open' : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M3 4l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
            </div>
            {expandedTools.has(tc.id) && tc.result && (
              <div className="chat-tool-call-result">
                <pre>{tc.result.length > 2000 ? tc.result.slice(0, 2000) + '\n...(truncated)' : tc.result}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const handleQuickAction = useCallback((prompt: string) => {
    if (prompt) {
      void sendMessage(prompt);
    } else {
      editableRef.current?.focus();
    }
  }, [sendMessage]);

  // Paste handler: strip HTML, insert plain text only
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // Event delegation: click on mention chip → focus canvas node
  const handleMessageClick = useCallback((e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement).closest('.chat-mention-chip--clickable') as HTMLElement | null;
    if (!chip) return;
    const nodeId = chip.dataset.nodeId;
    if (nodeId && onNodeFocus) {
      onNodeFocus(nodeId);
    }
  }, [onNodeFocus]);

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
                          {s.isCurrent ? 'Current chat' : (s.preview || s.date)}
                        </span>
                        <span className="chat-session-menu-item-count">{s.messageCount}</span>
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
        <div className="chat-messages" onClick={handleMessageClick}>
          {messages.map((msg, i) => {
            const isStreaming = loading && msg.role === 'assistant' && i === messages.length - 1;
            const tools = isStreaming ? streamingTools : messageTools.get(i);
            const isCollapsed = collapsedSections.has(i);
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
                <div className="chat-message-body">
                  {msg.role === 'assistant' && tools && tools.length > 0 && renderToolCalls(tools, i, isCollapsed)}
                  {msg.role === 'assistant' ? (
                    isStreaming ? (
                      msg.content ? (
                        <div
                          className="chat-message-content chat-md chat-md--streaming"
                          dangerouslySetInnerHTML={{ __html: renderMdWithMentions(msg.content, nodes) }}
                        />
                      ) : (!tools || tools.length === 0) ? (
                        <div className="chat-loading">
                          <div className="chat-loading-dot" />
                          <div className="chat-loading-dot" />
                          <div className="chat-loading-dot" />
                        </div>
                      ) : null
                    ) : (
                      <div
                        className="chat-message-content chat-md"
                        dangerouslySetInnerHTML={{ __html: renderMdWithMentions(msg.content, nodes) }}
                      />
                    )
                  ) : (
                    <div className="chat-message-content">{renderUserContent(msg.content, nodes)}</div>
                  )}
                </div>
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
              <div className="chat-message-body">
                <div className="chat-loading">
                  <div className="chat-loading-dot" />
                  <div className="chat-loading-dot" />
                  <div className="chat-loading-dot" />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="chat-input-container">
        {mentionOpen && mentionItems.length > 0 && (
          <div className="chat-mention-popup" ref={mentionRef}>
            {mentionItems.map((item, i) => (
              <button
                key={`${item.type}-${item.label}`}
                className={`chat-mention-item${i === mentionIndex ? ' chat-mention-item--active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); selectMention(item); }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <span className="chat-mention-item-icon">
                  {item.type === 'node' ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      {item.nodeType === 'file' && <><rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></>}
                      {item.nodeType === 'terminal' && <><rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M4 6l2 1.5L4 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" /></>}
                      {item.nodeType === 'agent' && <><circle cx="7" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.2" /><path d="M3.5 12c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>}
                      {item.nodeType === 'frame' && <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />}
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 1.5v11M4 4l-2.5 2.5L4 9M10 4l2.5 2.5L10 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="chat-mention-item-label">{item.label}</span>
                {item.type === 'node' && item.nodeType && (
                  <span className="chat-mention-item-type">{item.nodeType}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="chat-input-box">
          <div
            ref={editableRef}
            className="chat-input"
            contentEditable={!loading}
            role="textbox"
            data-placeholder="Ask anything..."
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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

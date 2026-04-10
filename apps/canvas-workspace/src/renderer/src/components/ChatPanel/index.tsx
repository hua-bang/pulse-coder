import { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import MarkdownIt from 'markdown-it';
import type { AgentChatMessage, AgentSessionInfo, CanvasNode } from '../../types';
import { AvatarIcon, CloseIcon, PlusIcon, ListLinesIcon } from '../icons';

interface OtherWorkspaceSession extends AgentSessionInfo {
  sourceWorkspaceId: string;
  workspaceName: string;
}
import './ChatPanel.css';

interface ChatPanelProps {
  workspaceId: string;
  /** All workspaces — used to load cross-workspace sessions. */
  allWorkspaces?: Array<{ id: string; name: string }>;
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
  type: 'node' | 'file' | 'workspace';
  label: string;
  nodeType?: string;
  path?: string;
  /** For workspace mentions — the target workspace's ID. */
  workspaceId?: string;
}

/** Prefix used to distinguish canvas/workspace mentions in the @[...] token. */
const CANVAS_MENTION_PREFIX = 'canvas:';

/**
 * Groups shown as section headers in the @ mention popup, in display order.
 * The key identifies the group for sort + render boundaries; `label` is the
 * header text the user sees.
 */
const MENTION_GROUPS = [
  { key: 'file',      label: 'File' },
  { key: 'agent',     label: 'Agent' },
  { key: 'terminal',  label: 'Terminal' },
  { key: 'frame',     label: 'Frame' },
  { key: 'canvas',    label: 'Canvas' },
  { key: 'proj-file', label: 'Project Files' },
] as const;

type MentionGroupKey = (typeof MENTION_GROUPS)[number]['key'];

const MENTION_GROUP_ORDER: MentionGroupKey[] = MENTION_GROUPS.map(g => g.key);
const MENTION_GROUP_LABEL: Record<MentionGroupKey, string> = Object.fromEntries(
  MENTION_GROUPS.map(g => [g.key, g.label]),
) as Record<MentionGroupKey, string>;

function getMentionGroupKey(item: MentionItem): MentionGroupKey {
  if (item.type === 'workspace') return 'canvas';
  if (item.type === 'file') return 'proj-file';
  // type === 'node' — discriminate by nodeType
  switch (item.nodeType) {
    case 'agent':    return 'agent';
    case 'terminal': return 'terminal';
    case 'frame':    return 'frame';
    case 'file':
    default:         return 'file';
  }
}

/** Max candidates shown in the @ popup. High enough that canvas nodes don't
 *  get clipped off the bottom even with many workspaces + project files. */
const MENTION_MAX_ITEMS = 30;

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

/**
 * Inner SVG markup for a given node type, shared between two rendering paths:
 *  - `mentionIconSvg` (HTML string concatenation, used inside `renderMdWithMentions`)
 *  - `MentionNodeIcon` (JSX component, used inside `renderUserContent` and the mention picker)
 * Path data is tuned for a 14×14 viewBox that's specific to chat mention chips;
 * the broader 16×16 `NodeTypeIcon` family in `components/icons` is used elsewhere.
 */
function mentionIconSvg(nodeType: string): string {
  switch (nodeType) {
    case 'terminal':
      return '<rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2 1.5L4 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>';
    case 'agent':
      return '<circle cx="7" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 12c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    case 'frame':
      return '<rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/>';
    case 'workspace':
      return '<rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="3.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/><rect x="7.5" y="3.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/><rect x="3.5" y="7.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/>';
    default: // file
      return '<rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
  }
}

/** JSX wrapper over `mentionIconSvg` — one source of truth for mention icon paths. */
const MentionNodeIcon = ({ nodeType, size = 12 }: { nodeType: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    dangerouslySetInnerHTML={{ __html: mentionIconSvg(nodeType) }}
  />
);

/**
 * Extract `@[canvas:Name]` tokens from a serialized message and resolve each
 * to a workspaceId using the caller's manifest. The current workspace and any
 * unresolved names are dropped. The returned list is deduped.
 */
function extractMentionedWorkspaceIds(
  text: string,
  allWorkspaces: Array<{ id: string; name: string }> | undefined,
  currentWorkspaceId: string,
): string[] {
  if (!allWorkspaces || allWorkspaces.length === 0) return [];
  const re = new RegExp(`@\\[${CANVAS_MENTION_PREFIX}([^\\]]+)\\]`, 'g');
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const ws = allWorkspaces.find(w => w.name === name);
    if (ws && ws.id !== currentWorkspaceId) ids.add(ws.id);
  }
  return Array.from(ids);
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
    const rawLabel = match[1];
    // Workspace (canvas) mention — shown as a dedicated chip style
    if (rawLabel.startsWith(CANVAS_MENTION_PREFIX)) {
      const wsLabel = rawLabel.slice(CANVAS_MENTION_PREFIX.length);
      parts.push(
        <span
          key={match.index}
          className="chat-mention-chip chat-mention-chip--workspace"
          data-node-type="workspace"
        >
          <span className="chat-mention-chip-icon">
            <MentionNodeIcon nodeType="workspace" />
          </span>
          <span className="chat-mention-chip-label">{wsLabel}</span>
        </span>
      );
      lastIndex = re.lastIndex;
      continue;
    }
    const label = rawLabel;
    // Try to resolve to a canvas node for type icon
    const node = nodes?.find(n => n.title === label);
    parts.push(
      <span key={match.index} className="chat-mention-chip chat-mention-chip--clickable" data-node-type={node?.type} data-node-id={node?.id}>
        <span className="chat-mention-chip-icon">
          <MentionNodeIcon nodeType={node?.type ?? 'file'} />
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
  return html.replace(MENTION_RE, (_match, rawLabel: string) => {
    if (rawLabel.startsWith(CANVAS_MENTION_PREFIX)) {
      const wsLabel = rawLabel.slice(CANVAS_MENTION_PREFIX.length);
      return `<span class="chat-mention-chip chat-mention-chip--workspace" data-node-type="workspace"><span class="chat-mention-chip-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg('workspace')}</svg></span><span class="chat-mention-chip-label">${wsLabel}</span></span>`;
    }
    const label = rawLabel;
    const node = nodes?.find(n => n.title === label);
    const nodeType = node?.type ?? 'file';
    const nodeId = node?.id ?? '';
    return `<span class="chat-mention-chip chat-mention-chip--clickable" data-node-type="${nodeType}" data-node-id="${nodeId}"><span class="chat-mention-chip-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg(nodeType)}</svg></span><span class="chat-mention-chip-label">${label}</span></span>`;
  });
}

interface PendingClarification {
  id: string;
  question: string;
  context?: string;
}

export const ChatPanel = ({ workspaceId, allWorkspaces, nodes, rootFolder, onClose, onResizeStart, onNodeFocus }: ChatPanelProps) => {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [otherSessions, setOtherSessions] = useState<OtherWorkspaceSession[]>([]);
  const [streamingTools, setStreamingTools] = useState<ToolCallStatus[]>([]);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  // Persist tool calls per message (msgIndex → tools). Not stored in message data.
  const [messageTools, setMessageTools] = useState<Map<number, ToolCallStatus[]>>(new Map());
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set());
  const toolIdCounter = useRef(0);
  const streamingMsgIdx = useRef(-1);

  // SessionId of the currently-running chat turn, used by the stop button
  // and the clarification answer flow. Null when idle.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // In-flight clarification request — when set, render an inline question
  // card with its own input. Cleared on answer, abort, or completion.
  const [pendingClarify, setPendingClarify] = useState<PendingClarification | null>(null);
  const [clarifyInput, setClarifyInput] = useState('');

  // Track active streaming subscriptions so they can be cleaned up on unmount
  const activeUnsubsRef = useRef<(() => void)[]>([]);

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

  // Load history on mount and clean up streaming subscriptions on unmount
  useEffect(() => {
    void (async () => {
      const result = await window.canvasWorkspace.agent.getHistory(workspaceId);
      if (result.ok && result.messages) {
        setMessages(result.messages);
      }
    })();

    // Reset per-run state when the user switches workspaces so nothing from
    // a previous workspace's in-flight run leaks into the new panel.
    setActiveSessionId(null);
    setPendingClarify(null);
    setClarifyInput('');

    return () => {
      // Unsubscribe any in-flight streaming listeners on unmount
      for (const unsub of activeUnsubsRef.current) {
        unsub();
      }
      activeUnsubsRef.current = [];
    };
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

  // Load sessions list when menu opens (current + other workspaces)
  const openSessionMenu = useCallback(async () => {
    if (sessionMenuOpen) {
      setSessionMenuOpen(false);
      return;
    }
    // Load current workspace sessions
    const result = await window.canvasWorkspace.agent.listSessions(workspaceId);
    if (result.ok && result.sessions) {
      setSessions(result.sessions);
    }
    // Load all workspace sessions for cross-workspace display
    if (allWorkspaces && allWorkspaces.length > 1) {
      const nameMap: Record<string, string> = {};
      for (const ws of allWorkspaces) {
        nameMap[ws.id] = ws.name;
      }
      const allResult = await window.canvasWorkspace.agent.listAllSessions(nameMap);
      if (allResult.ok && allResult.groups) {
        // Flatten into a single list with workspace metadata, exclude current workspace
        const flat: OtherWorkspaceSession[] = [];
        for (const g of allResult.groups) {
          if (g.workspaceId === workspaceId) continue;
          for (const s of g.sessions) {
            flat.push({ ...s, sourceWorkspaceId: g.workspaceId, workspaceName: g.workspaceName });
          }
        }
        // Sort by date descending (newest first)
        flat.sort((a, b) => b.date.localeCompare(a.date));
        setOtherSessions(flat);
      }
    } else {
      setOtherSessions([]);
    }
    setSessionMenuOpen(true);
  }, [sessionMenuOpen, workspaceId, allWorkspaces]);

  const handleNewSession = useCallback(async () => {
    setSessionMenuOpen(false);
    await window.canvasWorkspace.agent.newSession(workspaceId);
    setMessages([]);
    setMessageTools(new Map());
    setCollapsedSections(new Set());
  }, [workspaceId]);

  const handleLoadSession = useCallback(async (sessionId: string, sourceWorkspaceId?: string) => {
    setSessionMenuOpen(false);
    let result: { ok: boolean; messages?: AgentChatMessage[] };
    if (sourceWorkspaceId && sourceWorkspaceId !== workspaceId) {
      // Cross-workspace load
      result = await window.canvasWorkspace.agent.loadCrossWorkspaceSession(workspaceId, sourceWorkspaceId, sessionId);
    } else {
      result = await window.canvasWorkspace.agent.loadSession(workspaceId, sessionId);
    }
    if (result.ok && result.messages) {
      setMessages(result.messages);
    }
    setMessageTools(new Map());
    setCollapsedSections(new Set());
  }, [workspaceId]);

  // Scroll to bottom when messages, streaming tools, or a clarification card change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingTools, pendingClarify]);

  // Build mention items from nodes + files + other workspaces
  const buildMentionItems = useCallback(async (query: string) => {
    const items: MentionItem[] = [];
    // Other canvases (workspaces) — ordering is handled by MENTION_GROUPS below
    if (allWorkspaces) {
      for (const ws of allWorkspaces) {
        if (ws.id === workspaceId) continue;
        items.push({ type: 'workspace', label: ws.name, workspaceId: ws.id });
      }
    }
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
    // Sort by group order so rendering can insert section headers on group
    // boundaries. `sort` is stable in modern JS engines so intra-group order
    // is preserved (workspaces by manifest order, canvas nodes by z-order,
    // project files by listDir order).
    filtered.sort((a, b) => {
      const aOrder = MENTION_GROUP_ORDER.indexOf(getMentionGroupKey(a));
      const bOrder = MENTION_GROUP_ORDER.indexOf(getMentionGroupKey(b));
      return aOrder - bOrder;
    });
    return filtered.slice(0, MENTION_MAX_ITEMS);
  }, [allWorkspaces, workspaceId, nodes, rootFolder]);

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
      const mentionedWorkspaceIds = extractMentionedWorkspaceIds(
        text,
        allWorkspaces,
        workspaceId,
      );
      const result = await window.canvasWorkspace.agent.chat(
        workspaceId,
        text,
        mentionedWorkspaceIds.length > 0 ? mentionedWorkspaceIds : undefined,
      );
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
      setActiveSessionId(sessionId);

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

      const cleanupAllSubs = () => {
        unsubDelta();
        unsubComplete();
        unsubToolCall();
        unsubToolResult();
        unsubClarify();
        activeUnsubsRef.current = [];
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

      // Subscribe to clarification requests — render an inline card with its
      // own input so the user can answer without touching the main composer.
      const unsubClarify = window.canvasWorkspace.agent.onClarifyRequest(sessionId, (req) => {
        ensureAssistantMessage();
        setPendingClarify({ id: req.id, question: req.question, context: req.context });
        setClarifyInput('');
      });

      // Subscribe to completion
      const unsubComplete = window.canvasWorkspace.agent.onChatComplete(sessionId, (completeResult) => {
        cleanupAllSubs();
        // Collapse the tool section (don't clear — keep in messageTools)
        if (assistantIdx.current >= 0 && toolCalls.length > 0) {
          setCollapsedSections(prev => new Set(prev).add(assistantIdx.current));
        }
        setStreamingTools([]);
        setExpandedTools(new Set());
        streamingMsgIdx.current = -1;
        setActiveSessionId(null);
        setPendingClarify(null);
        setClarifyInput('');

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

      // Track all subscriptions so they can be cleaned up on workspace switch
      activeUnsubsRef.current.push(unsubToolCall, unsubToolResult, unsubDelta, unsubComplete, unsubClarify);
    } catch (err) {
      const errorMsg: AgentChatMessage = {
        role: 'assistant',
        content: `Error: ${String(err)}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMsg]);
      setLoading(false);
      setActiveSessionId(null);
      setPendingClarify(null);
      setClarifyInput('');
    }
  }, [input, loading, workspaceId, allWorkspaces]);

  /** Interrupt the currently-running generation. */
  const handleAbort = useCallback(async () => {
    const sid = activeSessionId;
    if (!sid) return;
    // Optimistically clear the pending clarify card so the UI responds
    // instantly; the chat-complete event will finish resetting state.
    setPendingClarify(null);
    setClarifyInput('');
    try {
      await window.canvasWorkspace.agent.abort(sid);
    } catch (err) {
      console.error('[chat-panel] abort failed:', err);
    }
  }, [activeSessionId]);

  /** Submit the user's reply to an in-flight clarification request. */
  const handleAnswerClarification = useCallback(async () => {
    const pending = pendingClarify;
    const sid = activeSessionId;
    if (!pending || !sid) return;
    const answer = clarifyInput.trim();
    if (!answer) return;
    // Hide the card immediately — the agent will continue and stream again.
    setPendingClarify(null);
    setClarifyInput('');
    try {
      await window.canvasWorkspace.agent.answerClarification(sid, pending.id, answer);
    } catch (err) {
      console.error('[chat-panel] clarification answer failed:', err);
    }
  }, [pendingClarify, activeSessionId, clarifyInput]);

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
    const isWorkspace = item.type === 'workspace';
    const nodeMatch = !isWorkspace ? nodes?.find(n => n.title === item.label) : undefined;
    const nodeType = isWorkspace ? 'workspace' : (nodeMatch?.type ?? (item.nodeType ?? 'file'));
    const chip = document.createElement('span');
    chip.className = isWorkspace
      ? 'chat-mention-chip chat-mention-chip--input chat-mention-chip--workspace'
      : 'chat-mention-chip chat-mention-chip--input';
    chip.contentEditable = 'false';
    // Serialize workspace mentions with a "canvas:" prefix so backend (and
    // future parsers) can tell them apart from node-title mentions.
    chip.dataset.mention = isWorkspace
      ? `${CANVAS_MENTION_PREFIX}${item.label}`
      : item.label;
    chip.dataset.nodeType = nodeType;
    if (isWorkspace && item.workspaceId) {
      chip.dataset.workspaceId = item.workspaceId;
    }
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
            <AvatarIcon size={16} />
            <span>Pulse Agent</span>
            <svg className="chat-panel-title-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {sessionMenuOpen && (
            <div className="chat-session-menu">
              <button className="chat-session-menu-new" onClick={() => void handleNewSession()}>
                <PlusIcon size={14} strokeWidth={1.3} />
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
                        <ListLinesIcon size={14} />
                        <span className="chat-session-menu-item-text">
                          {s.isCurrent ? 'Current chat' : (s.preview || s.date)}
                        </span>
                        <span className="chat-session-menu-item-count">{s.messageCount}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {otherSessions.length > 0 && (
                <>
                  <div className="chat-session-menu-divider" />
                  <div className="chat-session-menu-label">Other Workspaces</div>
                  <div className="chat-session-menu-list">
                    {otherSessions.map((s) => (
                      <button
                        key={s.sessionId}
                        className="chat-session-menu-item chat-session-menu-item--other-ws"
                        onClick={() => void handleLoadSession(s.sessionId, s.sourceWorkspaceId)}
                      >
                        <ListLinesIcon size={14} />
                        <span className="chat-session-menu-item-text">
                          {s.preview || s.date}
                        </span>
                        <span className="chat-session-menu-item-ws">{s.workspaceName}</span>
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
            <PlusIcon size={16} strokeWidth={1.3} />
          </button>
          <button className="chat-panel-action-btn" onClick={onClose} title="Close panel">
            <CloseIcon size={16} strokeWidth={1.3} />
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
                    <AvatarIcon size={14} />
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
                <AvatarIcon size={14} />
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
          {pendingClarify && (
            <div className="chat-message chat-message-assistant">
              <div className="chat-message-avatar">
                <AvatarIcon size={14} />
              </div>
              <div className="chat-message-body">
                <div className="chat-clarify-card">
                  <div className="chat-clarify-label">Needs clarification</div>
                  <div className="chat-clarify-question">{pendingClarify.question}</div>
                  {pendingClarify.context && (
                    <div className="chat-clarify-context">{pendingClarify.context}</div>
                  )}
                  <div className="chat-clarify-form">
                    <input
                      type="text"
                      className="chat-clarify-input"
                      value={clarifyInput}
                      onChange={(e) => setClarifyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void handleAnswerClarification();
                        }
                      }}
                      placeholder="Type your answer…"
                      autoFocus
                    />
                    <button
                      className="chat-clarify-submit"
                      onClick={() => void handleAnswerClarification()}
                      disabled={!clarifyInput.trim()}
                    >
                      Reply
                    </button>
                  </div>
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
            {mentionItems.map((item, i) => {
              const groupKey = getMentionGroupKey(item);
              const prevGroupKey = i > 0 ? getMentionGroupKey(mentionItems[i - 1]) : null;
              const showHeader = prevGroupKey !== groupKey;
              return (
                <Fragment key={`${item.type}-${item.nodeType ?? ''}-${item.workspaceId ?? ''}-${item.label}-${i}`}>
                  {showHeader && (
                    <div className="chat-mention-group-header">{MENTION_GROUP_LABEL[groupKey]}</div>
                  )}
                  <button
                    className={`chat-mention-item${i === mentionIndex ? ' chat-mention-item--active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); selectMention(item); }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <span className="chat-mention-item-icon">
                      <MentionNodeIcon
                        size={14}
                        nodeType={
                          item.type === 'workspace'
                            ? 'workspace'
                            : item.type === 'node'
                              ? item.nodeType ?? 'file'
                              : 'file'
                        }
                      />
                    </span>
                    <span className="chat-mention-item-label">{item.label}</span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        )}
        <div className={`chat-input-box${loading ? ' chat-input-box--generating' : ''}`}>
          <div
            ref={editableRef}
            className="chat-input"
            contentEditable={true}
            role="textbox"
            data-placeholder={loading ? 'Generating… you can type your next message' : 'Ask anything...'}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <div className="chat-input-footer">
            <div className="chat-input-footer-left">
              {loading && (
                <div className="chat-generating-indicator" aria-live="polite">
                  <div className="chat-loading-dot" />
                  <div className="chat-loading-dot" />
                  <div className="chat-loading-dot" />
                  <span className="chat-generating-label">Generating…</span>
                </div>
              )}
            </div>
            {loading ? (
              <button
                className="chat-send-btn chat-send-btn--stop"
                onClick={() => void handleAbort()}
                title="Stop generating"
                aria-label="Stop generating"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                className={`chat-send-btn${input.trim() ? ' chat-send-btn--active' : ''}`}
                onClick={() => void sendMessage()}
                disabled={!input.trim()}
                title="Send message"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 12V4M8 4l-3.5 3.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

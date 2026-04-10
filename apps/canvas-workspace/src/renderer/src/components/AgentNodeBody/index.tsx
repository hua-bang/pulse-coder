import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';
import { AGENT_REGISTRY, getAgentCommand, type AgentDef } from '../../config/agentRegistry';

/** Monoline SVG icon per agent, matching the app's stroke-icon style. */
const AgentIcon = ({ id }: { id: string }) => {
  switch (id) {
    case 'claude-code':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M5.5 6.5L7.5 8.5 5.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 10.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case 'codex':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 13V8l4-5 4 5v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 13v-3h2v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
};

interface Props {
  node: CanvasNode;
  allNodes?: CanvasNode[];
  rootFolder?: string;
  workspaceId?: string;
  workspaceName?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const SCROLLBACK_SAVE_INTERVAL = 2000;
const MAX_SCROLLBACK_CHARS = 50000;

const serializeBuffer = (term: Terminal): string => {
  const buf = term.buffer.active;
  const lines: string[] = [];
  const count = buf.length;
  for (let i = 0; i < count; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  let text = lines.join('\n');
  text = text.replace(/\n+$/, '');
  if (text.length > MAX_SCROLLBACK_CHARS) text = text.slice(-MAX_SCROLLBACK_CHARS);
  return text;
};

/** Truncate a path for display, keeping the last N segments. */
const truncatePath = (p: string, maxLen = 36): string => {
  if (p.length <= maxLen) return p;
  const parts = p.replace(/\/$/, '').split('/');
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + result;
    if (next.length > maxLen) return '\u2026/' + result;
    result = next;
  }
  return result;
};

export const AgentNodeBody = ({ node, rootFolder, workspaceId, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;
  const status = data.status ?? 'idle';

  const [selectedAgent, setSelectedAgent] = useState(data.agentType || 'claude-code');
  const [cwdInput, setCwdInput] = useState(data.cwd || '');
  const [launched, setLaunched] = useState(status === 'running' || status === 'done');

  // Refs that survive across the picker→terminal transition so the
  // useEffect that spawns after re-render can read the user's selection.
  const pendingAgentRef = useRef(data.agentType || 'claude-code');
  const pendingCwdRef = useRef(data.cwd || '');

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const spawnedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionId = data.sessionId || node.id;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const dataRef = useRef(data);
  dataRef.current = data;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const initialScrollback = useRef(data.scrollback ?? '');

  const spawnAgent = useCallback(async (agentType: string, cwd: string) => {
    if (!containerRef.current || termRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new Terminal(TERMINAL_OPTIONS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;

    if (initialScrollback.current) {
      const RESTORE_TAIL_LINES = 10;
      const lastLines = initialScrollback.current
        .split('\n')
        .slice(-RESTORE_TAIL_LINES)
        .join('\r\n');
      term.writeln('\x1b[2m--- session restored ---\x1b[0m');
      term.write(lastLines + '\r\n');
      term.writeln('\x1b[2m--- new session ---\x1b[0m\r\n');
    }

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    const api = window.canvasWorkspace?.pty;
    if (!api) {
      term.writeln('\x1b[31mError: pty API not available (preload missing)\x1b[0m');
      return;
    }

    const spawnCwd = cwd || rootFolder || undefined;
    const result = await api.spawn(sessionId, term.cols, term.rows, spawnCwd, workspaceId);
    if (!result.ok) {
      term.writeln(`\x1b[31mFailed to spawn shell: ${result.error}\x1b[0m`);
      onUpdateRef.current(nodeIdRef.current, {
        data: { ...dataRef.current, status: 'error' },
      });
      return;
    }

    // Resolve the agent command to write once the shell is ready
    const command = getAgentCommand(agentType);
    const writeCommand = () => {
      if (!command) {
        term.writeln(`\x1b[33mUnknown agent type: ${agentType}\x1b[0m`);
        return;
      }
      const { inlinePrompt, promptFile, agentArgs } = dataRef.current;
      if (inlinePrompt) {
        // Short prompt: pass directly as single-quoted CLI arg.
        // Single-quoted strings have zero shell interpretation.
        const escaped = inlinePrompt.replace(/'/g, "'\\''" );
        api.write(sessionId, `${command} '${escaped}'\n`);
      } else if (promptFile) {
        // Long prompt: read file into shell var, pass as single arg.
        // Shell variables in double quotes are NOT re-expanded.
        api.write(sessionId, `__prompt=$(cat ${promptFile}) && ${command} "$__prompt"\n`);
      } else if (agentArgs) {
        api.write(sessionId, `${command} ${agentArgs}\n`);
      } else {
        api.write(sessionId, `${command}\n`);
      }

      // The initial prompt is a one-shot task: once it has been written to
      // the PTY it has been consumed and must not be replayed. Clear the
      // persisted fields so that reopening the canvas re-attaches without
      // re-executing the same command. (We intentionally leave agentArgs
      // alone — that's a stable CLI arg the user may want on restart.)
      if (inlinePrompt || promptFile) {
        onUpdateRef.current(nodeIdRef.current, {
          data: { ...dataRef.current, inlinePrompt: '', promptFile: '' },
        });
      }
    };

    // Wait for the shell to emit its first output (prompt) before writing
    // the agent command. Writing immediately after spawn() would send the
    // command while the shell is still sourcing init scripts, causing it to
    // be lost or garbled.
    //
    // We start with a temporary onData listener that detects the first
    // output, then swap to the permanent listener that simply forwards all
    // data to xterm.
    let prompted = false;
    let removeData: (() => void) | null = null;

    const attachPermanentListener = () => {
      removeData = api.onData(sessionId, (d: string) => { term.write(d); });
    };

    const promptRemove = api.onData(sessionId, (d: string) => {
      term.write(d);
      if (!prompted) {
        prompted = true;
        promptRemove();
        attachPermanentListener();
        setTimeout(writeCommand, 100);
      }
    });

    const removeExit = api.onExit(sessionId, (code: number) => {
      term.writeln(`\r\n\x1b[2m[Agent exited with code ${code}]\x1b[0m`);
      onUpdateRef.current(nodeIdRef.current, {
        data: { ...dataRef.current, status: 'done' },
      });
    });

    term.onData((d: string) => {
      api.write(sessionId, d);
    });

    term.onResize(({ cols, rows }) => { api.resize(sessionId, cols, rows); });

    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, agentType, cwd: spawnCwd ?? '', status: 'running', sessionId },
    });

    saveTimerRef.current = setInterval(async () => {
      const scrollback = serializeBuffer(term);
      const cwdResult = await api.getCwd(sessionId);
      const curCwd = cwdResult.ok && cwdResult.cwd ? cwdResult.cwd : dataRef.current.cwd;
      onUpdateRef.current(nodeIdRef.current, {
        data: { ...dataRef.current, scrollback, cwd: curCwd },
      });
    }, SCROLLBACK_SAVE_INTERVAL);

    cleanupRef.current = () => {
      if (!prompted) promptRemove();
      removeData?.();
      removeExit();
      api.kill(sessionId);
    };
  }, [sessionId, rootFolder, workspaceId]);

  // Spawn the agent after React renders the terminal container.
  // pendingAgentRef / pendingCwdRef hold the user's picker selection
  // (or the restored values when resuming a previous session).
  useEffect(() => {
    if (launched && !spawnedRef.current) {
      void spawnAgent(pendingAgentRef.current, pendingCwdRef.current);
    }
    return () => {
      const api = window.canvasWorkspace?.pty;
      if (termRef.current && api) {
        const scrollback = serializeBuffer(termRef.current);
        void api.getCwd(sessionId).then((r) => {
          const cwd = r.ok && r.cwd ? r.cwd : dataRef.current.cwd;
          onUpdateRef.current(nodeIdRef.current, {
            data: { ...dataRef.current, scrollback, cwd },
          });
        });
      }
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
      cleanupRef.current?.();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      spawnedRef.current = false;
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launched]);

  useEffect(() => {
    if (!fitRef.current) return;
    const observer = new ResizeObserver(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [launched]);

  const handleLaunch = useCallback(() => {
    // Store the user's selection in refs so the useEffect (which fires
    // after React re-renders the terminal container) can read them.
    // We must NOT call spawnAgent here because containerRef is still null
    // (the picker UI is rendered, not the terminal div).
    pendingAgentRef.current = selectedAgent;
    pendingCwdRef.current = cwdInput;
    setLaunched(true);
  }, [selectedAgent, cwdInput]);

  const handleRestart = useCallback(() => {
    if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    cleanupRef.current?.();
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
    spawnedRef.current = false;
    cleanupRef.current = null;
    initialScrollback.current = '';

    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, status: 'idle', scrollback: '', sessionId: '' },
    });

    setLaunched(false);
  }, []);

  const handlePickFolder = useCallback(async () => {
    const api = window.canvasWorkspace?.dialog;
    if (!api) return;
    const result = await api.openFolder();
    if (result.ok && !result.canceled && result.folderPath) {
      setCwdInput(result.folderPath);
    }
  }, []);

  if (!launched) {
    const agentDef = AGENT_REGISTRY.find((a: AgentDef) => a.id === selectedAgent);
    return (
      <div className="agent-body-wrap">
        <div className="agent-picker">
          <div className="agent-picker-section">
            <span className="agent-picker-label">Agent</span>
            <div className="agent-card-list">
              {AGENT_REGISTRY.map((a: AgentDef) => (
                <button
                  key={a.id}
                  className={`agent-card${selectedAgent === a.id ? ' agent-card--active' : ''}`}
                  onClick={() => setSelectedAgent(a.id)}
                >
                  <span className="agent-card-icon"><AgentIcon id={a.id} /></span>
                  <span className="agent-card-name">{a.label}</span>
                  <span className="agent-card-desc">{a.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="agent-picker-section">
            <span className="agent-picker-label">Directory</span>
            <button className="agent-folder-btn" onClick={handlePickFolder}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <span className="agent-folder-path">
                {cwdInput ? truncatePath(cwdInput) : rootFolder ? truncatePath(rootFolder) : 'Choose folder\u2026'}
              </span>
            </button>
          </div>
          <button className="agent-launch-btn" onClick={handleLaunch}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
            </svg>
            Start {agentDef?.label ?? 'Agent'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-body-wrap">
      <div
        ref={containerRef}
        className="agent-xterm-container"
        onMouseDown={(e) => e.stopPropagation()}
      />
      {status === 'done' && (
        <div className="agent-restart-overlay">
          <button className="agent-restart-btn" onClick={handleRestart}>
            Restart Agent
          </button>
        </div>
      )}
    </div>
  );
};

import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData, AgentType } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';

interface Props {
  node: CanvasNode;
  rootFolder?: string;
  workspaceId?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const SCROLLBACK_SAVE_INTERVAL = 2000;
const MAX_SCROLLBACK_CHARS = 50000;

const AGENT_CONFIGS: Record<AgentType, { label: string; cmd: string }> = {
  'claude-code': { label: 'Claude Code', cmd: 'claude' },
  'codex':       { label: 'Codex CLI',   cmd: 'codex' },
  'pulse-coder': { label: 'Pulse Coder', cmd: 'pulse-coder' },
};

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

export const AgentNodeBody = ({ node, rootFolder, workspaceId, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;
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
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const initialScrollback = useRef(data.scrollback ?? '');
  const initialCwd = useRef(data.cwd ?? '');
  const initialAgentType = useRef(data.agentType);
  const initialStarted = useRef(data.started ?? false);

  const [agentType, setAgentType] = useState<AgentType>(data.agentType);
  const [started, setStarted] = useState(data.started ?? false);

  const persistState = useCallback(() => {
    const term = termRef.current;
    const scrollback = term ? serializeBuffer(term) : dataRef.current.scrollback;
    onUpdateRef.current(nodeIdRef.current, {
      data: {
        agentType: dataRef.current.agentType,
        sessionId: dataRef.current.sessionId,
        scrollback,
        cwd: dataRef.current.cwd,
        started: dataRef.current.started,
      },
    });
  }, []);

  const launchAgent = useCallback(() => {
    const api = window.canvasWorkspace?.pty;
    if (!api) return;
    const cfg = AGENT_CONFIGS[dataRef.current.agentType];
    // Launch in interactive mode — no -p flag so the user can keep talking
    api.write(sessionId, cfg.cmd + '\n');
    dataRef.current = { ...dataRef.current, started: true };
    setStarted(true);
    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, started: true },
    });
  }, [sessionId]);

  /** Send text to the running agent's stdin. */
  const sendToAgent = useCallback((text: string) => {
    const api = window.canvasWorkspace?.pty;
    if (!api || !text.trim()) return;
    api.write(sessionId, text + '\n');
  }, [sessionId]);

  const initTerminal = useCallback(async () => {
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

    const spawnCwd = initialCwd.current || rootFolder || undefined;
    const result = await api.spawn(sessionId, term.cols, term.rows, spawnCwd, workspaceIdRef.current);
    if (!result.ok) {
      term.writeln(`\x1b[31mFailed to spawn shell: ${result.error}\x1b[0m`);
      return;
    }

    const removeData = api.onData(sessionId, (d: string) => { term.write(d); });
    const removeExit = api.onExit(sessionId, (code: number) => {
      term.writeln(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m`);
    });

    term.onData((d: string) => {
      api.write(sessionId, d);
    });

    term.onResize(({ cols, rows }) => { api.resize(sessionId, cols, rows); });

    saveTimerRef.current = setInterval(async () => {
      const scrollback = serializeBuffer(term);
      const cwdResult = await api.getCwd(sessionId);
      const cwd = cwdResult.ok && cwdResult.cwd ? cwdResult.cwd : dataRef.current.cwd;
      onUpdateRef.current(nodeIdRef.current, {
        data: {
          agentType: dataRef.current.agentType,
          sessionId: dataRef.current.sessionId,
          scrollback,
          cwd,
          started: dataRef.current.started,
        },
      });
    }, SCROLLBACK_SAVE_INTERVAL);

    cleanupRef.current = () => {
      removeData();
      removeExit();
      api.kill(sessionId);
    };

    // If this is a fresh node (not restored), show a welcome hint
    if (!initialStarted.current && !initialScrollback.current) {
      const cfg = AGENT_CONFIGS[initialAgentType.current];
      term.writeln(`\x1b[2m[Agent: ${cfg.label}] Select agent type above and click Start.\x1b[0m\r\n`);
    }
  }, [sessionId, rootFolder, persistState]);

  useEffect(() => {
    void initTerminal();
    return () => {
      const api = window.canvasWorkspace?.pty;
      if (termRef.current && api) {
        const scrollback = serializeBuffer(termRef.current);
        void api.getCwd(sessionId).then((r) => {
          const cwd = r.ok && r.cwd ? r.cwd : dataRef.current.cwd;
          onUpdateRef.current(nodeIdRef.current, {
            data: {
              agentType: dataRef.current.agentType,
              sessionId: dataRef.current.sessionId,
              scrollback,
              cwd,
              started: dataRef.current.started,
            },
          });
        });
      } else if (termRef.current) {
        persistState();
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
  }, []);

  useEffect(() => {
    if (!fitRef.current) return;
    const observer = new ResizeObserver(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleAgentTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newType = e.target.value as AgentType;
    setAgentType(newType);
    dataRef.current = { ...dataRef.current, agentType: newType };
    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, agentType: newType },
    });
  }, []);

  const [promptValue, setPromptValue] = useState('');

  const handleStart = useCallback(() => {
    if (started) {
      // Agent already running — send the prompt text to stdin
      sendToAgent(promptValue);
    } else {
      launchAgent();
    }
    setPromptValue('');
  }, [started, launchAgent, sendToAgent, promptValue]);

  const handlePromptKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleStart();
    }
  }, [handleStart]);

  return (
    <div className="agent-body">
      <div className="agent-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <select
          className="agent-type-select"
          value={agentType}
          onChange={handleAgentTypeChange}
          disabled={started}
        >
          {Object.entries(AGENT_CONFIGS).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        {started ? (
          <>
            <input
              className="agent-prompt-input"
              type="text"
              placeholder="Send message to agent..."
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={handlePromptKeyDown}
            />
            <button
              className="agent-start-btn"
              onClick={handleStart}
              disabled={!promptValue.trim()}
              title="Send message to agent"
            >
              Send
            </button>
          </>
        ) : (
          <button
            className="agent-start-btn agent-start-btn--launch"
            onClick={handleStart}
            title="Launch agent in interactive mode"
          >
            Start
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        className="agent-xterm-container"
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
};

import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';
import { AGENT_REGISTRY, getAgentCommand } from '../../config/agentRegistry';

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

export const AgentNodeBody = ({ node, rootFolder, workspaceId, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;
  const status = data.status ?? 'idle';

  const [selectedAgent, setSelectedAgent] = useState(data.agentType || 'claude-code');
  const [cwdInput, setCwdInput] = useState(data.cwd || '');
  const [launched, setLaunched] = useState(status === 'running' || status === 'done');

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

    const removeData = api.onData(sessionId, (d: string) => { term.write(d); });
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

    // Launch the agent command
    const command = getAgentCommand(agentType);
    if (command) {
      const args = dataRef.current.agentArgs ? ` ${dataRef.current.agentArgs}` : '';
      api.write(sessionId, `${command}${args}\n`);
    } else {
      term.writeln(`\x1b[33mUnknown agent type: ${agentType}\x1b[0m`);
    }

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
      removeData();
      removeExit();
      api.kill(sessionId);
    };
  }, [sessionId, rootFolder, workspaceId]);

  // If already launched (e.g. restored from save with running status), auto-spawn
  useEffect(() => {
    if (launched && !spawnedRef.current) {
      void spawnAgent(data.agentType, data.cwd ?? '');
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
    setLaunched(true);
    void spawnAgent(selectedAgent, cwdInput);
  }, [spawnAgent, selectedAgent, cwdInput]);

  const handleRestart = useCallback(() => {
    // Clean up existing session
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

  const agentDef = AGENT_REGISTRY.find(a => a.id === selectedAgent);

  if (!launched) {
    return (
      <div className="agent-body-wrap">
        <div className="agent-picker">
          <div className="agent-picker-field">
            <label>Agent</label>
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
            >
              {AGENT_REGISTRY.map(a => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
            {agentDef && (
              <span className="agent-picker-description">{agentDef.description}</span>
            )}
          </div>
          <div className="agent-picker-field">
            <label>Working Directory</label>
            <input
              type="text"
              placeholder={rootFolder || 'default'}
              value={cwdInput}
              onChange={(e) => setCwdInput(e.target.value)}
            />
          </div>
          <button className="agent-launch-btn" onClick={handleLaunch}>
            Launch Agent
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

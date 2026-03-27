import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, TerminalNodeData } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';
import { AI_TOOL_PATTERN, writeCanvasContext } from '../../utils/canvasContextWriter';
import { NodeMentionPicker } from '../NodeMentionPicker';

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

export const TerminalNodeBody = ({ node, allNodes, rootFolder, workspaceId, workspaceName, onUpdate }: Props) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const spawnedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const data = node.data as TerminalNodeData;
  const sessionId = data.sessionId || node.id;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const dataRef = useRef(data);
  dataRef.current = data;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const allNodesRef = useRef(allNodes);
  allNodesRef.current = allNodes;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const workspaceNameRef = useRef(workspaceName);
  workspaceNameRef.current = workspaceName;
  const initialScrollback = useRef(data.scrollback ?? '');
  const initialCwd = useRef(data.cwd ?? '');

  const persistState = useCallback(() => {
    const term = termRef.current;
    const scrollback = term ? serializeBuffer(term) : dataRef.current.scrollback;
    onUpdateRef.current(nodeIdRef.current, {
      data: { sessionId: dataRef.current.sessionId, scrollback, cwd: dataRef.current.cwd },
    });
  }, []);

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

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.key === '2' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        setPickerOpen(true);
        return false;
      }
      return true;
    });

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    const api = window.canvasWorkspace?.pty;
    if (!api) {
      term.writeln('\x1b[31mError: pty API not available (preload missing)\x1b[0m');
      return;
    }

    const spawnCwd = initialCwd.current || rootFolder || undefined;
    const result = await api.spawn(sessionId, term.cols, term.rows, spawnCwd);
    if (!result.ok) {
      term.writeln(`\x1b[31mFailed to spawn shell: ${result.error}\x1b[0m`);
      return;
    }

    const removeData = api.onData(sessionId, (d: string) => { term.write(d); });
    const removeExit = api.onExit(sessionId, (code: number) => {
      term.writeln(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m`);
    });

    let inputBuf = '';
    term.onData((d: string) => {
      api.write(sessionId, d);
      if (d === '\r' || d === '\n') {
        const cmd = inputBuf.trim();
        inputBuf = '';
        if (AI_TOOL_PATTERN.test(cmd) && allNodesRef.current && allNodesRef.current.length > 0) {
          void api.getCwd(sessionId).then((r) => {
            const cwd = r.ok && r.cwd ? r.cwd : spawnCwd;
            if (cwd) void writeCanvasContext(allNodesRef.current!, cwd, workspaceIdRef.current, workspaceNameRef.current, term);
          });
        }
      } else if (d === '\x7f') {
        inputBuf = inputBuf.slice(0, -1);
      } else if (d.length === 1 && d >= ' ') {
        inputBuf += d;
      }
    });

    term.onResize(({ cols, rows }) => { api.resize(sessionId, cols, rows); });

    saveTimerRef.current = setInterval(async () => {
      const scrollback = serializeBuffer(term);
      const cwdResult = await api.getCwd(sessionId);
      const cwd = cwdResult.ok && cwdResult.cwd ? cwdResult.cwd : dataRef.current.cwd;
      onUpdateRef.current(nodeIdRef.current, {
        data: { sessionId: dataRef.current.sessionId, scrollback, cwd },
      });
    }, SCROLLBACK_SAVE_INTERVAL);

    cleanupRef.current = () => {
      removeData();
      removeExit();
      api.kill(sessionId);
    };
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
            data: { sessionId: dataRef.current.sessionId, scrollback, cwd },
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

  const handleMentionSelect = useCallback((selected: CanvasNode) => {
    setPickerOpen(false);
    const api = window.canvasWorkspace?.pty;
    if (api) void api.write(sessionId, selected.title);
    termRef.current?.focus();
  }, [sessionId]);

  const handleMentionClose = useCallback(() => {
    setPickerOpen(false);
    termRef.current?.focus();
  }, []);

  return (
    <div className="terminal-body-wrap">
      {pickerOpen && (
        <NodeMentionPicker
          nodes={allNodes ?? []}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}
      <div
        ref={containerRef}
        className="terminal-xterm-container"
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
};

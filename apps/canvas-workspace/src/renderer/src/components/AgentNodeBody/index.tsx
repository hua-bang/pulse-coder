import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData, FileNodeData } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';
import { getAgentCommand } from '../../config/agentRegistry';
import {
  SCROLLBACK_SAVE_INTERVAL,
  loadRecentCwds,
  pushRecentCwd,
  serializeBuffer,
} from './utils/terminal';
import { AgentPicker } from './AgentPicker';
import { AgentTerminal } from './AgentTerminal';
import { AgentRestart } from './AgentRestart';
import { NodeMentionPicker } from '../NodeMentionPicker';

interface Props {
  node: CanvasNode;
  getAllNodes?: () => CanvasNode[];
  rootFolder?: string;
  workspaceId?: string;
  workspaceName?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  readOnly?: boolean;
}

type ViewMode = 'setup' | 'running' | 'restart';

/**
 * Mint a fresh PTY session id for a new spawn. We deliberately avoid
 * reusing the node id (or a stale persisted sessionId) because the
 * backend's `pty:spawn` short-circuits with `{ reused: true }` when the
 * id is already in its map — and `pty:kill` is a fire-and-forget IPC,
 * so a kill+respawn on the same id races and can attach the renderer
 * to a session that gets torn down a moment later (resulting in an
 * empty, dead terminal).
 */
const mintSessionId = (nodeId: string): string =>
  `${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Read the current agent view from persisted data. The body keeps
 * `data.viewMode` in sync with its real runtime view, so this function
 * trusts that field above all else — including the presence of saved
 * scrollback, which can be a legitimate live-session artifact (the save
 * timer writes scrollback every 2s while the PTY is alive).
 *
 * Exported so the outer `CanvasNodeView` header can render a matching
 * status pill from persisted data without needing a callback handshake
 * with the body.
 *
 * Mount-time cold-reload detection lives in `AgentNodeBody`'s own
 * `useState` initializer below — the body needs that nuance, the header
 * doesn't.
 */
export const detectAgentView = (data: AgentNodeData): ViewMode => {
  if (data.viewMode === 'setup') return 'setup';
  if (data.viewMode === 'running') return 'running';
  if (data.viewMode === 'restart') return 'restart';
  // Legacy fallback for nodes persisted before `viewMode` existed.
  const status = data.status ?? 'idle';
  const hasPriorSession =
    !!(data.sessionId && data.sessionId.length > 0)
    || !!(data.scrollback && data.scrollback.length > 0);
  if (hasPriorSession) return 'restart';
  if (status === 'running' || status === 'done' || status === 'error') return 'running';
  return 'setup';
};

export const AgentNodeBody = ({ node, getAllNodes, rootFolder, workspaceId, onUpdate, readOnly = false }: Props) => {
  const data = node.data as AgentNodeData;
  const status = data.status ?? 'idle';

  const [selectedAgent, setSelectedAgent] = useState(data.agentType || 'claude-code');
  const [cwdInput, setCwdInput] = useState(data.cwd || '');
  const [promptInput, setPromptInput] = useState(data.inlinePrompt || data.lastInitPrompt || '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>(loadRecentCwds);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    // Mount-time cold-reload override: if the persisted `viewMode` is
    // `running` but the renderer just remounted (i.e. this useState
    // initializer is firing), the PTY that backed it is gone. Saved
    // sessionId / scrollback are the proof that a live session existed
    // at some point. Land on Restart so the user gets a clear recovery
    // affordance instead of a dead terminal pretending to be live.
    const hasPriorSession =
      !!(data.sessionId && data.sessionId.length > 0)
      || !!(data.scrollback && data.scrollback.length > 0);
    if (data.viewMode === 'running' && hasPriorSession) return 'restart';
    return detectAgentView(data);
  });
  /** True after a Setup view was entered via the Restart card's "Edit" action,
   * so we can show a Back link and route the next launch back to Restart on
   * cancel. */
  const [fromRestart, setFromRestart] = useState(false);

  // Refs that survive across the setup→running transition so the
  // useEffect that spawns after re-render can read the user's selection.
  const pendingAgentRef = useRef(data.agentType || 'claude-code');
  const pendingCwdRef = useRef(data.cwd || '');
  const pendingPromptRef = useRef(data.inlinePrompt || '');

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
  const getAllNodesRef = useRef(getAllNodes);
  getAllNodesRef.current = getAllNodes;

  const spawnAgent = useCallback(
    async (agentType: string, cwd: string, inlinePromptOverride?: string) => {
      if (!containerRef.current || termRef.current || spawnedRef.current) return;

      if (readOnly) {
        spawnedRef.current = true;
        const term = new Terminal(TERMINAL_OPTIONS);
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        termRef.current = term;
        fitRef.current = fitAddon;
        const saved = dataRef.current.scrollback;
        if (saved) {
          term.writeln('\x1b[2m--- restored agent output ---\x1b[0m');
          term.write(saved.split('\n').join('\r\n'));
          term.writeln('');
        } else {
          term.writeln('\x1b[2m--- no saved agent output ---\x1b[0m');
        }
        requestAnimationFrame(() => {
          try { fitAddon.fit(); } catch { /* ignore */ }
        });
        return;
      }
      spawnedRef.current = true;

      const term = new Terminal(TERMINAL_OPTIONS);
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;

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

      // Resolve the agent command to write once the shell is ready
      const command = getAgentCommand(agentType);
      const writeCommand = () => {
        if (!command) {
          term.writeln(`\x1b[33mUnknown agent type: ${agentType}\x1b[0m`);
          return;
        }
        const { inlinePrompt, promptFile, agentArgs } = dataRef.current;
        const effectivePrompt = inlinePromptOverride || inlinePrompt;
        if (effectivePrompt) {
          const escaped = effectivePrompt.replace(/'/g, "'\\''");
          api.write(sessionId, `${command} '${escaped}'\n`);
        } else if (promptFile) {
          api.write(sessionId, `__prompt=$(cat ${promptFile}) && ${command} "$__prompt"\n`);
        } else if (agentArgs) {
          api.write(sessionId, `${command} ${agentArgs}\n`);
        } else {
          api.write(sessionId, `${command}\n`);
        }

        if (effectivePrompt || promptFile) {
          // Clear `inlinePrompt`/`promptFile` so they don't re-fire on next
          // spawn, but stash a copy in `lastInitPrompt` so the Restart view
          // can show what the previous session was started with.
          onUpdateRef.current(nodeIdRef.current, {
            data: {
              ...dataRef.current,
              inlinePrompt: '',
              promptFile: '',
              lastInitPrompt: effectivePrompt || dataRef.current.lastInitPrompt || '',
            },
          });
        }
      };

      // Attach the data listener BEFORE awaiting spawn. The backend creates
      // the PTY synchronously inside the spawn handler and the shell starts
      // emitting its prompt almost immediately, so if we wait for the await
      // to resolve before attaching, the first chunk of output arrives on
      // an IPC channel with no listener and is dropped — producing a black
      // terminal that never prints anything. Attaching first is safe: until
      // the spawn handler runs there's no one to emit, and ipcRenderer.on
      // happily waits for events.
      let prompted = false;
      const removeDataRef: { current: (() => void) | null } = { current: null };

      const attachPermanentListener = () => {
        removeDataRef.current = api.onData(sessionId, (d: string) => { term.write(d); });
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

      const spawnCwd = cwd || rootFolder || undefined;
      const result = await api.spawn(sessionId, term.cols, term.rows, spawnCwd, workspaceId);
      if (!result.ok) {
        if (!prompted) promptRemove();
        removeDataRef.current?.();
        removeExit();
        term.writeln(`\x1b[31mFailed to spawn shell: ${result.error}\x1b[0m`);
        onUpdateRef.current(nodeIdRef.current, {
          data: { ...dataRef.current, status: 'error' },
        });
        return;
      }

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
        removeDataRef.current?.();
        removeExit();
        api.kill(sessionId);
      };
    },
    [sessionId, rootFolder, workspaceId, readOnly],
  );

  useEffect(() => {
    if (viewMode === 'running' && !spawnedRef.current) {
      void spawnAgent(
        pendingAgentRef.current,
        pendingCwdRef.current,
        pendingPromptRef.current,
      );
    }
    return () => {
      // Only snapshot terminal contents back to the node when there was a
      // live PTY. The Restart view persists its own data and shouldn't
      // round-trip the dead xterm buffer.
      const api = window.canvasWorkspace?.pty;
      if (termRef.current && api && viewMode === 'running') {
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
  }, [viewMode]);

  useEffect(() => {
    if (!fitRef.current) return;
    const observer = new ResizeObserver(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [viewMode]);

  // Persist viewMode so the outer canvas-node header can render a matching
  // status pill. Skipped while readOnly to avoid mutating a node opened in
  // a viewer / shared workspace.
  useEffect(() => {
    if (readOnly) return;
    if (dataRef.current.viewMode === viewMode) return;
    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, viewMode },
    });
  }, [viewMode, readOnly]);

  const handleLaunch = useCallback(() => {
    if (readOnly) return;
    const effectiveCwd = cwdInput || rootFolder || '';
    const prompt = promptInput.trim();
    pendingAgentRef.current = selectedAgent;
    pendingCwdRef.current = effectiveCwd;
    pendingPromptRef.current = prompt;
    if (effectiveCwd) {
      setRecentCwds(pushRecentCwd(effectiveCwd));
    }
    const api = window.canvasWorkspace?.pty;
    const oldSessionId = dataRef.current.sessionId;
    if (api && oldSessionId) api.kill(oldSessionId);
    const freshSessionId = mintSessionId(nodeIdRef.current);
    // Persist the launch intent to disk immediately. If the user reloads
    // before spawnAgent's own post-spawn update commits, the node will
    // reopen in the Restart view (because sessionId/scrollback get persisted
    // a moment later by the save timer) instead of regressing to Setup.
    onUpdateRef.current(nodeIdRef.current, {
      data: {
        ...dataRef.current,
        agentType: selectedAgent,
        cwd: effectiveCwd,
        inlinePrompt: prompt,
        lastInitPrompt: prompt || dataRef.current.lastInitPrompt || '',
        status: 'running',
        sessionId: freshSessionId,
        scrollback: '',
      },
    });
    setFromRestart(false);
    setViewMode('running');
  }, [selectedAgent, cwdInput, promptInput, rootFolder, readOnly]);

  const handleMentionSelect = useCallback((selected: CanvasNode) => {
    if (readOnly) return;
    setPickerOpen(false);
    const api = window.canvasWorkspace?.pty;
    if (api) {
      const filePath = selected.type === 'file'
        ? (selected.data as FileNodeData).filePath
        : undefined;
      const label = filePath ? filePath.split('/').pop() : selected.title;
      const mention = `@[${label}](canvas:${selected.id})`;
      void api.write(sessionId, mention);
    }
    termRef.current?.focus();
  }, [sessionId, readOnly]);

  const handleMentionClose = useCallback(() => {
    setPickerOpen(false);
    termRef.current?.focus();
  }, []);

  /** Restart with saved config from the Restart view. Mints a fresh
   * sessionId and explicitly kills any leftover backend session so a
   * cold-reload-leaked PTY doesn't intercept the new spawn. */
  const handleRestartSession = useCallback(() => {
    if (readOnly) return;
    const savedAgent = data.agentType || selectedAgent;
    const savedCwd = data.cwd || rootFolder || '';
    const savedPrompt = data.lastInitPrompt || '';
    pendingAgentRef.current = savedAgent;
    pendingCwdRef.current = savedCwd;
    pendingPromptRef.current = savedPrompt;
    const api = window.canvasWorkspace?.pty;
    const oldSessionId = dataRef.current.sessionId;
    if (api && oldSessionId) api.kill(oldSessionId);
    const freshSessionId = mintSessionId(nodeIdRef.current);
    onUpdateRef.current(nodeIdRef.current, {
      data: {
        ...dataRef.current,
        agentType: savedAgent,
        cwd: savedCwd,
        inlinePrompt: savedPrompt,
        status: 'running',
        sessionId: freshSessionId,
        scrollback: '',
      },
    });
    setFromRestart(false);
    setViewMode('running');
  }, [data.agentType, data.cwd, data.lastInitPrompt, selectedAgent, rootFolder, readOnly]);

  const handleEditInit = useCallback(() => {
    if (readOnly) return;
    setSelectedAgent(data.agentType || selectedAgent);
    setCwdInput(data.cwd || '');
    setPromptInput(data.lastInitPrompt || '');
    setFromRestart(true);
    setViewMode('setup');
  }, [data.agentType, data.cwd, data.lastInitPrompt, selectedAgent, readOnly]);

  const handleBackToRestart = useCallback(() => {
    setFromRestart(false);
    setViewMode('restart');
  }, []);

  const handlePickFolder = useCallback(async () => {
    if (readOnly) return;
    const api = window.canvasWorkspace?.dialog;
    if (!api) return;
    const result = await api.openFolder();
    if (result.ok && !result.canceled && result.folderPath) {
      setCwdInput(result.folderPath);
    }
  }, [readOnly]);

  if (viewMode === 'setup') {
    return (
      <AgentPicker
        selectedAgent={selectedAgent}
        cwdInput={cwdInput}
        promptInput={promptInput}
        rootFolder={rootFolder}
        recentCwds={recentCwds}
        onBack={fromRestart ? handleBackToRestart : undefined}
        onAgentChange={setSelectedAgent}
        onCwdChange={setCwdInput}
        onPromptChange={setPromptInput}
        onPickFolder={handlePickFolder}
        onLaunch={handleLaunch}
      />
    );
  }

  if (viewMode === 'restart') {
    return (
      <AgentRestart
        agentType={data.agentType || 'claude-code'}
        cwd={data.cwd}
        prompt={data.lastInitPrompt}
        scrollback={data.scrollback}
        onRestart={handleRestartSession}
        onEdit={handleEditInit}
      />
    );
  }

  return (
    <>
      {!readOnly && pickerOpen && (
        <NodeMentionPicker
          nodes={getAllNodesRef.current?.() ?? []}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}
      <AgentTerminal
        containerRef={containerRef}
        status={status}
        agentType={data.agentType || 'claude-code'}
        cwd={data.cwd}
      />
    </>
  );
};

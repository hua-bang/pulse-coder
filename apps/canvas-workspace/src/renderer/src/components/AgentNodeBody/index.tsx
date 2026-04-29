import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData } from '../../types';
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

interface Props {
  node: CanvasNode;
  allNodes?: CanvasNode[];
  rootFolder?: string;
  workspaceId?: string;
  workspaceName?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const AgentNodeBody = ({ node, rootFolder, workspaceId, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;
  const status = data.status ?? 'idle';

  const [selectedAgent, setSelectedAgent] = useState(data.agentType || 'claude-code');
  const [cwdInput, setCwdInput] = useState(data.cwd || '');
  const [promptInput, setPromptInput] = useState(data.inlinePrompt || '');
  const [recentCwds, setRecentCwds] = useState<string[]>(loadRecentCwds);
  // Treat any of the following as evidence that the node has been launched
  // before and should skip the picker on mount:
  //   - an explicit running/done/error status,
  //   - saved scrollback (the 2s interval writes this even when a status
  //     update was lost to the debounced-save race),
  //   - a persisted sessionId (only set after spawn succeeds).
  // The scrollback/sessionId fallbacks rescue nodes that were launched under
  // an earlier buggy code path where status never made it to disk.
  const [launched, setLaunched] = useState(
    status === 'running'
      || status === 'done'
      || status === 'error'
      || !!(data.scrollback && data.scrollback.length > 0)
      || !!(data.sessionId && data.sessionId.length > 0),
  );

  // Refs that survive across the picker→terminal transition so the
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
  const initialScrollback = useRef(data.scrollback ?? '');
  /**
   * Distinguishes a fresh user-initiated launch (picker → Start click) from
   * the other ways `launched` can become true on mount. On a cold reload
   * of a previously spawned PTY the backing shell has been torn down and
   * cannot be reattached, so we must NOT re-spawn and re-run the agent
   * command — doing so both destroys the saved terminal output and can
   * race with status persistence.
   *
   * Note: this ref alone isn't sufficient to identify a cold reload — a
   * tool-triggered auto-launch (e.g. `canvas_create_agent_node` with
   * `autoLaunch: true`) also mounts with `launched=true` without a Start
   * click but has never spawned a PTY. The mount effect combines this
   * ref with `data.sessionId`/`data.scrollback` to tell the two apart.
   *
   * Stays `false` across re-renders; flipped to `true` in `handleLaunch`
   * and reset in `handleRestart`.
   */
  const userLaunchedRef = useRef(false);
  /** Tracks whether spawnAgent entered the restored (no-PTY) branch so the
   * cleanup effect knows to skip PTY-related teardown. */
  const isRestoredRef = useRef(false);

  const spawnAgent = useCallback(
    async (
      agentType: string,
      cwd: string,
      inlinePromptOverride?: string,
      isRestored = false,
    ) => {
      if (!containerRef.current || termRef.current || spawnedRef.current) return;
      spawnedRef.current = true;
      isRestoredRef.current = isRestored;

      const term = new Terminal(TERMINAL_OPTIONS);
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;

      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });

      if (isRestored) {
        // Cold reload: the PTY was killed on the previous unmount, so we
        // cannot reattach. Replay the full saved scrollback as static
        // output and mark status as 'done' so the Restart button shows.
        // The user can click Restart to explicitly spawn a fresh session.
        if (initialScrollback.current) {
          term.writeln('\x1b[2m--- restored from previous session ---\x1b[0m');
          term.write(initialScrollback.current.split('\n').join('\r\n'));
          term.writeln('');
        } else {
          term.writeln('\x1b[2m--- previous session (no saved output) ---\x1b[0m');
        }
        if (dataRef.current.status !== 'done') {
          onUpdateRef.current(nodeIdRef.current, {
            data: { ...dataRef.current, status: 'done' },
          });
        }
        return;
      }

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
        const effectivePrompt = inlinePromptOverride || inlinePrompt;
        // `agentArgs` is always prepended (between the binary and any
        // prompt arg) so that flags like `--dangerously-skip-permissions`
        // / `--full-auto` survive even when the agent is launched with a
        // prompt. Previously agentArgs was treated as an alternative to
        // the prompt — that lost any flags the team coordinator wanted
        // to bake in.
        const argsPrefix = agentArgs ? `${agentArgs} ` : '';
        if (effectivePrompt) {
          const escaped = effectivePrompt.replace(/'/g, "'\\''");
          api.write(sessionId, `${command} ${argsPrefix}'${escaped}'\n`);
        } else if (promptFile) {
          api.write(sessionId, `__prompt=$(cat ${promptFile}) && ${command} ${argsPrefix}"$__prompt"\n`);
        } else if (agentArgs) {
          api.write(sessionId, `${command} ${agentArgs}\n`);
        } else {
          api.write(sessionId, `${command}\n`);
        }

        if (effectivePrompt || promptFile) {
          onUpdateRef.current(nodeIdRef.current, {
            data: { ...dataRef.current, inlinePrompt: '', promptFile: '' },
          });
        }
      };

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
    },
    [sessionId, rootFolder, workspaceId],
  );

  useEffect(() => {
    if (launched && !spawnedRef.current) {
      // If the component is mounting with launched=true but the user did
      // NOT click Start in this render lifecycle, there are two sub-cases:
      //   a) Cold reload of a real previous session — the prior PTY had
      //      spawned (so `sessionId` was persisted by spawnAgent) or had
      //      output serialized to `scrollback`. The PTY was killed on the
      //      previous unmount and cannot be reattached; replay scrollback.
      //   b) A tool just created this node (e.g.
      //      `canvas_create_agent_node` with autoLaunch) and persisted
      //      `status: 'running'` without ever spawning a PTY. `sessionId`
      //      and `scrollback` are both empty — we must do a FRESH spawn,
      //      otherwise the terminal hangs showing "previous session (no
      //      saved output)" and the agent never runs.
      const hasPriorSession =
        !!(data.sessionId && data.sessionId.length > 0)
        || !!(data.scrollback && data.scrollback.length > 0);
      const isRestored = !userLaunchedRef.current && hasPriorSession;
      void spawnAgent(
        pendingAgentRef.current,
        pendingCwdRef.current,
        pendingPromptRef.current,
        isRestored,
      );
    }
    return () => {
      const api = window.canvasWorkspace?.pty;
      // Only snapshot terminal contents back to the node when there was a
      // live PTY to serialize. Restored nodes already hold the authoritative
      // scrollback on disk; re-serializing the xterm buffer would round-trip
      // through display formatting and drift the saved output over time.
      if (termRef.current && api && !isRestoredRef.current) {
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
      isRestoredRef.current = false;
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
    const effectiveCwd = cwdInput || rootFolder || '';
    const prompt = promptInput.trim();
    pendingAgentRef.current = selectedAgent;
    pendingCwdRef.current = effectiveCwd;
    pendingPromptRef.current = prompt;
    if (effectiveCwd) {
      setRecentCwds(pushRecentCwd(effectiveCwd));
    }
    // Mark this launch as user-initiated so the mount effect doesn't treat
    // the upcoming render as a cold-reload restore.
    userLaunchedRef.current = true;
    // Persist the launch intent to disk immediately. If the user reloads
    // before spawnAgent's own post-spawn update commits, the node will
    // still reopen in launched state (terminal view) instead of regressing
    // to the initial picker.
    onUpdateRef.current(nodeIdRef.current, {
      data: {
        ...dataRef.current,
        agentType: selectedAgent,
        cwd: effectiveCwd,
        inlinePrompt: prompt,
        status: 'running',
      },
    });
    setLaunched(true);
  }, [selectedAgent, cwdInput, promptInput, rootFolder]);

  const handleStop = useCallback(() => {
    const api = window.canvasWorkspace?.pty;
    if (api) api.kill(sessionId);
    onUpdateRef.current(nodeIdRef.current, {
      data: { ...dataRef.current, status: 'done' },
    });
  }, [sessionId]);

  const handleSendPrompt = useCallback((prompt: string) => {
    const api = window.canvasWorkspace?.pty;
    if (!api) return;
    api.write(sessionId, `\n${prompt}\n`);
  }, [sessionId]);

  const handleRestart = useCallback(() => {
    if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    cleanupRef.current?.();
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
    spawnedRef.current = false;
    cleanupRef.current = null;
    initialScrollback.current = '';
    // Next Start click must be treated as a fresh user launch, not a
    // restore — clear the flag so the mount effect won't short-circuit.
    userLaunchedRef.current = false;
    isRestoredRef.current = false;

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
    return (
      <AgentPicker
        selectedAgent={selectedAgent}
        cwdInput={cwdInput}
        promptInput={promptInput}
        rootFolder={rootFolder}
        recentCwds={recentCwds}
        onAgentChange={setSelectedAgent}
        onCwdChange={setCwdInput}
        onPromptChange={setPromptInput}
        onPickFolder={handlePickFolder}
        onLaunch={handleLaunch}
      />
    );
  }

  return (
    <AgentTerminal
      containerRef={containerRef}
      status={status}
      onRestart={handleRestart}
      onStop={handleStop}
      onSendPrompt={handleSendPrompt}
    />
  );
};

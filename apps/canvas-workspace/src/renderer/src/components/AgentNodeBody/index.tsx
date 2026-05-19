import { useEffect, useRef, useCallback, useState } from 'react';
import './index.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CanvasNode, AgentNodeData, FileNodeData } from '../../types';
import { TERMINAL_OPTIONS } from '../../config/terminalTheme';
import { getAgentDef } from '../../config/agentRegistry';
import {
  SCROLLBACK_SAVE_INTERVAL,
  loadRecentCwds,
  pushRecentCwd,
  serializeBuffer,
} from './utils/terminal';
import { AgentPicker } from './AgentPicker';
import { AgentTerminal } from './AgentTerminal';
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

export const AgentNodeBody = ({ node, getAllNodes, rootFolder, workspaceId, onUpdate, readOnly = false }: Props) => {
  const data = node.data as AgentNodeData;
  const status = data.status ?? 'idle';

  const [selectedAgent, setSelectedAgent] = useState(data.agentType || 'claude-code');
  const [cwdInput, setCwdInput] = useState(data.cwd || '');
  const [promptInput, setPromptInput] = useState(data.inlinePrompt || '');
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const getAllNodesRef = useRef(getAllNodes);
  getAllNodesRef.current = getAllNodes;
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
   * and reset in `handleNewSession`.
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

      const agentDef = getAgentDef(agentType);
      // A cold-reloaded node can re-attach to its prior conversation only
      // when the agent CLI supports id-based resume AND we previously
      // persisted a resumeId on first launch. Otherwise we fall back to a
      // static replay of the saved scrollback.
      const canResume = isRestored
        && !!agentDef?.resume
        && !!dataRef.current.resumeId;

      if (readOnly) {
        spawnedRef.current = true;
        isRestoredRef.current = true;
        const term = new Terminal(TERMINAL_OPTIONS);
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        termRef.current = term;
        fitRef.current = fitAddon;
        if (initialScrollback.current) {
          term.writeln('\x1b[2m--- restored agent output ---\x1b[0m');
          term.write(initialScrollback.current.split('\n').join('\r\n'));
          term.writeln('');
        } else {
          term.writeln('\x1b[2m--- no saved agent output ---\x1b[0m');
        }
        requestAnimationFrame(() => {
          try { fitAddon.fit(); } catch { /* ignore */ }
        });
        return;
      }

      // Cold reload of an agent that can't resume — show the saved output
      // as static text and let the user explicitly Restart for a fresh run.
      if (isRestored && !canResume) {
        spawnedRef.current = true;
        isRestoredRef.current = true;
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

      // Live PTY path — fresh user launch, OR cold reload of a resume-
      // capable agent (we'll write the agent's resume command below).
      spawnedRef.current = true;
      isRestoredRef.current = false;

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

      // On resume, surface the prior conversation as a faded preamble so
      // the user sees history above the re-attached live session.
      if (canResume && initialScrollback.current) {
        term.writeln('\x1b[2m--- previous session (resuming) ---\x1b[0m');
        term.write(initialScrollback.current.split('\n').join('\r\n'));
        term.writeln('');
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

      // Decide the resumable conversation id for this launch:
      //   - canResume: reuse the persisted id, run `--resume <id>`
      //   - fresh launch of a resume-capable agent: pre-allocate a UUID
      //     and start with `--session-id <id>` so a future cold reload can
      //     re-attach by id
      //   - non-resumable agent: leave undefined, run the plain command
      let resumeId: string | undefined = dataRef.current.resumeId;
      if (!canResume && !resumeId && agentDef?.resume) {
        resumeId = crypto.randomUUID();
      }

      const writeCommand = () => {
        let cmd: string;
        if (canResume && resumeId && agentDef?.resume) {
          cmd = agentDef.resume.resume(resumeId);
        } else if (resumeId && agentDef?.resume) {
          cmd = agentDef.resume.startWithId(resumeId);
        } else if (agentDef?.command) {
          cmd = agentDef.command;
        } else {
          term.writeln(`\x1b[33mUnknown agent type: ${agentType}\x1b[0m`);
          return;
        }

        // Resuming attaches to an existing conversation that already
        // contains the user's original prompt — re-passing it would
        // create a duplicate turn. Just launch the resume command.
        if (canResume) {
          api.write(sessionId, `${cmd}\n`);
          return;
        }

        const { inlinePrompt, promptFile, agentArgs } = dataRef.current;
        const effectivePrompt = inlinePromptOverride || inlinePrompt;
        if (effectivePrompt) {
          const escaped = effectivePrompt.replace(/'/g, "'\\''");
          api.write(sessionId, `${cmd} '${escaped}'\n`);
        } else if (promptFile) {
          api.write(sessionId, `__prompt=$(cat ${promptFile}) && ${cmd} "$__prompt"\n`);
        } else if (agentArgs) {
          api.write(sessionId, `${cmd} ${agentArgs}\n`);
        } else {
          api.write(sessionId, `${cmd}\n`);
        }

        // Intentionally NOT clearing `inlinePrompt` / `promptFile` here:
        // keeping the last prompt around lets the picker pre-fill on a
        // Start-fresh, so users don't have to retype a similar request.
        // The resume path skips re-passing the prompt anyway (see the
        // `canResume` early return above), so a stale `inlinePrompt`
        // can't double-fire during cold reload.
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
        // Status stays 'done' regardless of code — the badge in
        // SessionEndBar branches on `lastExitCode` instead. `status:
        // 'error'` remains reserved for *spawn* failures (see the
        // `if (!result.ok)` branch above).
        onUpdateRef.current(nodeIdRef.current, {
          data: { ...dataRef.current, status: 'done', lastExitCode: code },
        });
      });

      term.onData((d: string) => {
        api.write(sessionId, d);
      });

      term.onResize(({ cols, rows }) => { api.resize(sessionId, cols, rows); });

      onUpdateRef.current(nodeIdRef.current, {
        data: {
          ...dataRef.current,
          agentType,
          cwd: spawnCwd ?? '',
          status: 'running',
          sessionId,
          ...(resumeId ? { resumeId } : {}),
        },
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
    [sessionId, rootFolder, workspaceId, readOnly],
  );

  useEffect(() => {
    if (launched && !spawnedRef.current) {
      // If the component is mounting with launched=true but the user did
      // NOT click Start in this render lifecycle, there are two sub-cases:
      //   a) Cold reload of a real previous session — the prior PTY had
      //      spawned (so `sessionId` was persisted by spawnAgent) or had
      //      output serialized to `scrollback`. The PTY was killed on the
      //      previous unmount; if the agent CLI supports id-based resume
      //      and a `resumeId` is persisted, spawnAgent re-attaches by id,
      //      otherwise it falls back to a static replay of scrollback.
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
    if (readOnly) return;
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

  /**
   * "Continue" — keep the conversation alive without surfacing a
   * "restart" concept to the user. Tears down the dead PTY refs and
   * re-invokes spawnAgent on the resume path so the agent re-attaches
   * to the same `resumeId` and the prior scrollback is preserved as a
   * faded preamble. Only meaningful for resume-capable agents; the
   * caller (session-end bar) hides this action otherwise.
   */
  const handleContinue = useCallback(() => {
    if (readOnly) return;
    if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    cleanupRef.current?.();
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
    spawnedRef.current = false;
    cleanupRef.current = null;
    isRestoredRef.current = false;

    // Use the *latest* persisted scrollback as the resume preamble.
    // The mount-time `initialScrollback` ref would be stale after the
    // user has continued one or more times in this session.
    initialScrollback.current = dataRef.current.scrollback ?? '';

    // Spawn on the resume path: spawnAgent reads `agentDef.resume` plus
    // `dataRef.current.resumeId` and writes `<agent> --resume <id>`.
    void spawnAgent(
      dataRef.current.agentType,
      dataRef.current.cwd ?? '',
      undefined,
      true,
    );
  }, [readOnly, spawnAgent]);

  /**
   * Copy the visible terminal output as plain text (ANSI escapes
   * stripped), so users can grab a result without scrolling-selecting
   * inside xterm.
   */
  const handleCopyOutput = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const text = lines.join('\n').replace(/\n+$/, '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard permission denied — silent fail; nothing critical */
    }
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
    <div className="agent-body-wrap">
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
        lastExitCode={data.lastExitCode}
        canResume={!!getAgentDef(data.agentType)?.resume}
        onContinue={handleContinue}
        onCopyOutput={handleCopyOutput}
      />
    </div>
  );
};

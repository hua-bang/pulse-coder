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

/**
 * After a cold reload, decide whether to silently resume instead of
 * showing the Restart card. Each agent gets in based on whether its
 * CLI actually has a "pick up the conversation" affordance we can
 * invoke headlessly:
 *   - Claude Code: pinned to a caller-supplied cliSessionId on first
 *     spawn → resumed via `claude --resume <uuid>` deterministically.
 *   - Codex CLI: no caller-supplied id, but `codex resume --last`
 *     picks the most recent session in the current cwd — close
 *     enough for our per-node continuity model.
 *   - Pulse-Coder: no resume integration yet, stays on Restart card.
 *
 * Limited to `status === 'running'` across the board so a node the
 * user saw exit (status='done' or 'error') still surfaces the Restart
 * card; auto-reviving an agent the user thought was stopped would be
 * surprising.
 */
const shouldAutoResume = (data: AgentNodeData): boolean => {
  if (data.status !== 'running') return false;
  if (data.viewMode !== 'running') return false;
  const hasPriorSession =
    !!(data.sessionId && data.sessionId.length > 0)
    || !!(data.scrollback && data.scrollback.length > 0);
  if (!hasPriorSession) return false;
  if (data.agentType === 'claude-code') return !!data.cliSessionId;
  if (data.agentType === 'codex') return true;
  return false;
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
    // at some point. Normally we'd land on Restart so the user picks
    // up where they left off explicitly — except Claude Code with a
    // persisted cliSessionId can be silently resumed via `--resume
    // <uuid>`, which is the truly seamless behavior. In that case we
    // skip the Restart card entirely and route straight back to the
    // running view; the spawn below picks the right flag because
    // pendingResumeRef gets initialized to true alongside.
    if (shouldAutoResume(data)) return 'running';
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
  /** True from the moment spawnAgent starts until the agent CLI has
   *  printed something substantive (or a 12s fail-safe elapses).
   *  Drives the loading overlay shown over the otherwise-empty
   *  terminal during the multi-second CLI bootstrap. */
  const [loading, setLoading] = useState(false);

  // Refs that survive across the setup→running transition so the
  // useEffect that spawns after re-render can read the user's selection.
  const pendingAgentRef = useRef(data.agentType || 'claude-code');
  const pendingCwdRef = useRef(data.cwd || '');
  const pendingPromptRef = useRef(data.inlinePrompt || '');
  /** True when the next spawn should resume an existing CLI session
   *  instead of creating a new one. Flipped by handleRestartSession,
   *  reset by handleLaunch. Initialized to true on mount when the
   *  cold-reload heuristic auto-routes a Claude Code node into
   *  `running`, so the resumed spawn uses `--resume <uuid>` instead
   *  of `--session-id <uuid>`. */
  const pendingResumeRef = useRef(shouldAutoResume(data));
  /** True only on initial mount when shouldAutoResume(data) was true.
   *  Consumed by the spawn effect to force a fresh backend PTY:
   *  without this, the main process's still-warm session map would
   *  short-circuit `pty:spawn` into `{ reused: true }` and the new
   *  xterm would reattach to a Claude whose alt-screen state we have
   *  no way to recover, leaving the panel visually frozen. */
  const needsAutoMintRef = useRef(shouldAutoResume(data));

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const spawnedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const dataRef = useRef(data);
  dataRef.current = data;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const getAllNodesRef = useRef(getAllNodes);
  getAllNodesRef.current = getAllNodes;

  const spawnAgent = useCallback(
    async (
      agentType: string,
      cwd: string,
      inlinePromptOverride: string | undefined,
      resumeMode: boolean,
      sessionId: string,
    ) => {
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
      setLoading(true);

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

      // Fit synchronously *before* spawn so the PTY is created at the
      // terminal's actual rendered dimensions. Without this, spawn
      // would use xterm's default 80×24, and TUI agents like Claude
      // Code lay out their input prompt at what they think is the
      // bottom (row 24) — which in our larger panel ends up parked
      // partway down the screen with empty space underneath. A second
      // RAF-deferred fit covers the rare case where the container
      // hadn't finished layout at this point.
      try { fitAddon.fit(); } catch { /* ignore */ }
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });

      const api = window.canvasWorkspace?.pty;
      if (!api) {
        term.writeln('\x1b[31mError: pty API not available (preload missing)\x1b[0m');
        return;
      }

      // Resolve the agent command to write once the shell is ready.
      // Two agents currently understand "pick up where you left off":
      //   - Claude Code: we mint a UUID ourselves and pin the
      //     conversation to it via `--session-id <uuid>` on the first
      //     spawn, then `--resume <uuid>` on every restart. The id
      //     lives on the node so resume is deterministic regardless
      //     of what else has run in the same cwd.
      //   - Codex CLI: doesn't accept a caller-supplied id, so on the
      //     first spawn we launch codex bare, run `/status` to surface
      //     its self-assigned session id, parse it out of the TUI
      //     output, persist it on the node, then send the user's
      //     prompt. Later restarts use `codex resume <uuid>` for a
      //     precise resume; if the capture failed (no id stored), we
      //     fall back to `codex resume --last`.
      // Other agents (Pulse-Coder) fall through to a plain spawn.
      const command = getAgentCommand(agentType);
      const existingCliSessionId = dataRef.current.cliSessionId;
      const claudeSessionId = existingCliSessionId || crypto.randomUUID();
      const canResumeClaude = !!existingCliSessionId;
      const writeCommandTimeRef = { current: 0 };
      // Quiescence helpers used by the Codex capture flow. The permanent
      // data listener (attached just below) keeps `lastDataTime` fresh
      // and appends to `captureBuffer` while `capturing` is on; the
      // orchestrator polls these to know when codex has finished
      // streaming a chunk of TUI output.
      let lastDataTime = Date.now();
      let capturing = false;
      let captureBuffer = '';
      // Snapshot lastDataTime when waitForQuiescence starts, and only
      // resolve once we've seen new data after that snapshot AND then
      // gone idle for idleMs. Without the "new data" check, calling
      // waitForQuiescence right after the previous burst ended would
      // see "already idle for 900ms" and return instantly — before
      // the IPC we just sent (e.g. `/status`) had any chance to be
      // processed by the PTY and emit a response.
      const waitForQuiescence = (idleMs: number, maxMs: number) =>
        new Promise<void>((resolve) => {
          const start = Date.now();
          const baseline = lastDataTime;
          const tick = () => {
            const sawNewData = lastDataTime > baseline;
            if (sawNewData && Date.now() - lastDataTime >= idleMs) return resolve();
            if (Date.now() - start >= maxMs) return resolve();
            setTimeout(tick, 80);
          };
          tick();
        });
      const stripAnsi = (s: string) =>
        s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

      const escapePrompt = (s: string) => s.replace(/'/g, "'\\''");

      const writeCommandFlow = async () => {
        if (!command) {
          term.writeln(`\x1b[33mUnknown agent type: ${agentType}\x1b[0m`);
          setLoading(false);
          return;
        }
        writeCommandTimeRef.current = Date.now();

        const { inlinePrompt, promptFile, agentArgs } = dataRef.current;
        const effectivePrompt = inlinePromptOverride || inlinePrompt;

        if (agentType === 'codex') {
          if (resumeMode) {
            const target = existingCliSessionId || '--last';
            console.log('[agent:codex] resume', { target, existingCliSessionId });
            api.write(sessionId, `${command} resume ${target}\n`);
          } else if (!existingCliSessionId) {
            // First-ever Codex spawn for this node: launch bare,
            // capture the session id via /status, then send the
            // prompt. Best-effort; if capture fails (TUI changes
            // format, timeout, no UUID in output) we just send the
            // prompt and restart falls back to `resume --last`.
            console.log('[agent:codex] capture flow: launching bare codex');
            api.write(sessionId, `${command}\n`);
            // Wait for codex banner / TUI to finish drawing.
            await waitForQuiescence(900, 12_000);
            // Codex shows an interactive "Update available" picker at
            // startup when a newer version is on npm — defaults to
            // "Skip" so a bare \r dismisses it. If no picker is up,
            // the \r is a harmless no-op against the empty input box.
            // Without this, the first /status we send gets eaten as
            // keystrokes into the picker and never makes it to the
            // main TUI.
            console.log('[agent:codex] dismissing any startup picker');
            api.write(sessionId, '\r');
            await new Promise((r) => setTimeout(r, 500));
            console.log('[agent:codex] banner quiesced, sending /status');
            // Run /status; everything written to the channel from
            // here until quiescence is captured for parsing.
            captureBuffer = '';
            capturing = true;
            // Use \r (carriage return) — that's the byte a real Enter
            // key emits in TUI raw mode. \n alone is treated by Codex
            // as "insert newline" inside its multi-line input box.
            api.write(sessionId, '/status\r');
            await waitForQuiescence(600, 5_000);
            capturing = false;
            const stripped = stripAnsi(captureBuffer);
            const match = stripped.match(UUID_RE);
            console.log('[agent:codex] /status captured', {
              bytes: captureBuffer.length,
              strippedSample: stripped.slice(0, 600),
              matchedUuid: match?.[0] ?? null,
            });
            if (match) {
              onUpdateRef.current(nodeIdRef.current, {
                data: { ...dataRef.current, cliSessionId: match[0] },
              });
            }
            // Dismiss the /status panel before sending the prompt
            // so codex sees a clean input line.
            api.write(sessionId, '\x1b');
            await new Promise((r) => setTimeout(r, 200));
            if (effectivePrompt) {
              // Write the text first, give the TUI a beat to render
              // (so it doesn't see one big burst it might treat as a
              // paste), then send the actual Enter as a separate \r.
              api.write(sessionId, effectivePrompt);
              await new Promise((r) => setTimeout(r, 80));
              api.write(sessionId, '\r');
            }
            // No-prompt case: just leave Codex sitting at its empty
            // input box. The /status capture + ESC has already run,
            // so cliSessionId is persisted (or we'll fall back to
            // --last on restart). User types their first message
            // manually.
          } else {
            // Codex with a captured id from a prior spawn but no
            // resumeMode (shouldn't normally happen — Setup → 初始化
            // mints a fresh node — but handle defensively).
            if (effectivePrompt) {
              api.write(sessionId, `${command} '${escapePrompt(effectivePrompt)}'\n`);
            } else {
              api.write(sessionId, `${command}\n`);
            }
          }
        } else {
          const flags =
            agentType === 'claude-code'
              ? ` ${resumeMode && canResumeClaude ? '--resume' : '--session-id'} ${claudeSessionId}`
              : '';
          if (effectivePrompt) {
            api.write(sessionId, `${command}${flags} '${escapePrompt(effectivePrompt)}'\n`);
          } else if (promptFile) {
            api.write(sessionId, `__prompt=$(cat ${promptFile}) && ${command}${flags} "$__prompt"\n`);
          } else if (agentArgs) {
            api.write(sessionId, `${command}${flags} ${agentArgs}\n`);
          } else {
            api.write(sessionId, `${command}${flags}\n`);
          }
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
      // Two-phase loading-overlay dismissal so the spinner stays up
      // through the multi-second CLI startup and goes away the moment
      // the user can actually interact:
      //   Phase 1: after writeCommand, ignore the first ~300ms of
      //            output (that's the shell echoing our launch command,
      //            not the agent itself). The next chunk after that
      //            window marks "banner started".
      //   Phase 2: once banner started, each chunk resets a 500ms
      //            quiescence timer. When the agent finally falls
      //            silent — the natural signal that the banner is
      //            done printing and it's waiting for input —
      //            quiescence elapses and we dismiss.
      // A 15s fail-safe still covers pathological cases (agent never
      // emits anything past the echo). The shell-error / agent-exit /
      // effect-cleanup paths also call dismissLoading() so it can't
      // wedge.
      const ECHO_WINDOW_MS = 300;
      const QUIESCENCE_MS = 500;
      const FAILSAFE_MS = 15_000;
      let loadingDismissed = false;
      let bannerStarted = false;
      let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
      const dismissLoading = () => {
        if (loadingDismissed) return;
        loadingDismissed = true;
        if (quiescenceTimer) {
          clearTimeout(quiescenceTimer);
          quiescenceTimer = null;
        }
        setLoading(false);
      };
      const scheduleQuiescence = () => {
        if (loadingDismissed) return;
        if (quiescenceTimer) clearTimeout(quiescenceTimer);
        quiescenceTimer = setTimeout(() => {
          quiescenceTimer = null;
          dismissLoading();
        }, QUIESCENCE_MS);
      };
      const loadingTimeout = setTimeout(dismissLoading, FAILSAFE_MS);

      const attachPermanentListener = () => {
        removeDataRef.current = api.onData(sessionId, (d: string) => {
          term.write(d);
          // Always update — used by the Codex capture flow's
          // waitForQuiescence helper to know when codex has stopped
          // streaming a chunk of TUI output.
          lastDataTime = Date.now();
          if (capturing) captureBuffer += d;
          if (loadingDismissed) return;
          if (writeCommandTimeRef.current === 0) return;
          const since = Date.now() - writeCommandTimeRef.current;
          if (!bannerStarted) {
            // Still inside the shell-echo window — wait for the next
            // post-echo chunk before treating output as "banner".
            if (since <= ECHO_WINDOW_MS) return;
            bannerStarted = true;
          }
          scheduleQuiescence();
        });
      };

      const promptRemove = api.onData(sessionId, (d: string) => {
        term.write(d);
        if (!prompted) {
          prompted = true;
          promptRemove();
          attachPermanentListener();
          setTimeout(() => { void writeCommandFlow(); }, 100);
        }
      });

      const removeExit = api.onExit(sessionId, (code: number) => {
        term.writeln(`\r\n\x1b[2m[Agent exited with code ${code}]\x1b[0m`);
        dismissLoading();
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
        clearTimeout(loadingTimeout);
        dismissLoading();
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

      // Persist Claude's caller-supplied UUID right after spawn so the
      // node always carries a stable cliSessionId even if the very
      // first interaction never completes. Codex's id is captured
      // later by the /status flow inside writeCommandFlow, so we leave
      // whatever's already on the node intact for Codex / other agents.
      onUpdateRef.current(nodeIdRef.current, {
        data: {
          ...dataRef.current,
          agentType,
          cwd: spawnCwd ?? '',
          status: 'running',
          sessionId,
          ...(agentType === 'claude-code' ? { cliSessionId: claudeSessionId } : {}),
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
        removeDataRef.current?.();
        removeExit();
        clearTimeout(loadingTimeout);
        dismissLoading();
        api.kill(sessionId);
      };
    },
    [rootFolder, workspaceId, readOnly],
  );

  useEffect(() => {
    if (viewMode === 'running' && !spawnedRef.current) {
      let runSessionId = dataRef.current.sessionId || nodeIdRef.current;
      if (needsAutoMintRef.current) {
        // Auto-resume cold-reload prep: the handler-triggered paths
        // (handleLaunch / handleRestartSession) already mint a fresh
        // PTY sessionId before flipping viewMode, but this auto-mount
        // path bypasses them. Without the kill+mint, the backend's
        // still-warm pty:spawn returns `reused: true` for our old id
        // and the new xterm wires up to a Claude whose alt-screen
        // state it can't see.
        needsAutoMintRef.current = false;
        const apiPty = window.canvasWorkspace?.pty;
        if (apiPty && runSessionId) apiPty.kill(runSessionId);
        runSessionId = mintSessionId(nodeIdRef.current);
        onUpdateRef.current(nodeIdRef.current, {
          data: { ...dataRef.current, sessionId: runSessionId, scrollback: '' },
        });
      }
      void spawnAgent(
        pendingAgentRef.current,
        pendingCwdRef.current,
        pendingPromptRef.current,
        pendingResumeRef.current,
        runSessionId,
      );
    }
    return () => {
      // Only snapshot terminal contents back to the node when there was a
      // live PTY. The Restart view persists its own data and shouldn't
      // round-trip the dead xterm buffer.
      const api = window.canvasWorkspace?.pty;
      if (termRef.current && api && viewMode === 'running') {
        const scrollback = serializeBuffer(termRef.current);
        const activeSessionId = dataRef.current.sessionId || nodeIdRef.current;
        void api.getCwd(activeSessionId).then((r) => {
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
      setLoading(false);
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
    pendingResumeRef.current = false;
    if (effectiveCwd) {
      setRecentCwds(pushRecentCwd(effectiveCwd));
    }
    const api = window.canvasWorkspace?.pty;
    const oldSessionId = dataRef.current.sessionId;
    if (api && oldSessionId) api.kill(oldSessionId);
    const freshSessionId = mintSessionId(nodeIdRef.current);
    // 初始化 always starts a brand-new conversation. cliSessionId is
    // pre-minted only for Claude Code, whose CLI accepts our UUID via
    // --session-id. For Codex we must clear it so spawnAgent's
    // "no prior id" branch fires and runs the /status capture; a
    // randomly minted UUID here would short-circuit that detection
    // (Codex doesn't accept caller-supplied ids — a stale random UUID
    // isn't a real Codex session and would just confuse resume later).
    // Other agents (Pulse-Coder) don't use cliSessionId at all.
    const freshCliSessionId =
      selectedAgent === 'claude-code' ? crypto.randomUUID() : '';
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
        cliSessionId: freshCliSessionId,
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
      const activeSessionId = dataRef.current.sessionId || nodeIdRef.current;
      void api.write(activeSessionId, mention);
    }
    termRef.current?.focus();
  }, [readOnly]);

  const handleMentionClose = useCallback(() => {
    setPickerOpen(false);
    termRef.current?.focus();
  }, []);

  /** Restart with saved config from the Restart view. Mints a fresh
   * PTY sessionId and explicitly kills any leftover backend session so a
   * cold-reload-leaked PTY doesn't intercept the new spawn. The CLI-level
   * session (cliSessionId) is preserved so Claude Code can resume the
   * conversation in-place via `--resume <uuid>`. */
  const handleRestartSession = useCallback(() => {
    if (readOnly) return;
    const savedAgent = data.agentType || selectedAgent;
    const savedCwd = data.cwd || rootFolder || '';
    const savedPrompt = data.lastInitPrompt || '';
    pendingAgentRef.current = savedAgent;
    pendingCwdRef.current = savedCwd;
    pendingPromptRef.current = savedPrompt;
    // Resume strategies that the spawn supports:
    //   - Claude Code with a stored cliSessionId → `--resume <uuid>`
    //   - Codex CLI (any prior session in this cwd)  → `resume --last`
    pendingResumeRef.current =
      (savedAgent === 'claude-code' && !!dataRef.current.cliSessionId)
      || savedAgent === 'codex';
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
        loading={loading}
      />
    </>
  );
};

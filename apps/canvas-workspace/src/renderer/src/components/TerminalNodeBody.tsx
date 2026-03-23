import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { CanvasNode, TerminalNodeData, FileNodeData } from "../types";

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

const extractDescription = (content: string): string => {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // skip markdown headings, use their text
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) return heading[1];
    // skip horizontal rules
    if (/^[-*_]{3,}$/.test(line)) continue;
    // return first meaningful line, strip inline markdown
    return line.replace(/[*_`#>]/g, '').trim().slice(0, 80);
  }
  return '';
};

const MARKER_START = (id: string) => `<!-- canvas-workspace:${id} -->`;
const MARKER_END = (id: string) => `<!-- /canvas-workspace:${id} -->`;

const buildCanvasContext = (
  nodes: CanvasNode[],
  workspaceFolder: string,
  workspaceId?: string,
  workspaceName?: string,
  canvasDir?: string,
): string => {
  const fileNodes = nodes.filter(n => n.type === 'file');
  if (fileNodes.length === 0 && !canvasDir) return '';

  const label = workspaceName
    ? `${workspaceName}${workspaceId ? ` (${workspaceId})` : ''}`
    : (workspaceId ?? 'default');

  const lines = [
    '# Canvas Workspace Context',
    '',
    `Workspace: ${label}`,
    `Folder: ${workspaceFolder}`,
  ];

  if (canvasDir) {
    lines.push(`Canvas dir: ${canvasDir}`);
    lines.push(`Canvas data: ${canvasDir}/canvas.json`);
    lines.push(`Notes dir: ${canvasDir}/notes/`);
  }

  if (fileNodes.length > 0) {
    lines.push('', '## Files on Canvas', '');
    for (const node of fileNodes) {
      const d = node.data as FileNodeData;
      const pathHint = d.filePath ? `\`${d.filePath}\`` : '(unsaved)';
      const desc = extractDescription(d.content);
      lines.push(`- **${node.title}** ${pathHint}${desc ? ` — ${desc}` : ''}`);
    }
  }

  lines.push('', '> Use the file paths above to read content as needed.', '');
  return lines.join('\n');
};

/** Replace or append a workspace-scoped section in file content. */
const upsertSection = (existing: string, id: string, section: string): string => {
  const start = MARKER_START(id);
  const end = MARKER_END(id);
  const block = `${start}\n${section}\n${end}`;
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + block + existing.slice(endIdx + end.length);
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
};

/** Commands that trigger lazy canvas context injection into CLAUDE.md / AGENTS.md */
const AI_TOOL_PATTERN = /\b(claude|codex|pulse-coder|pulsecoder)\b/;

/** 写入 canvas/{wsId}/AGENTS.md 的完整画布上下文（含用户自定义内容）。 */
const writeCanvasAgentsMd = async (
  fileApi: NonNullable<typeof window.canvasWorkspace>['file'],
  canvasDir: string,
  context: string,
): Promise<void> => {
  const existing = await fileApi.read(`${canvasDir}/AGENTS.md`).then(r => (r.ok ? r.content ?? '' : ''));
  // 保留用户在模板注释之外写的内容，追加/替换 [Auto-generated] 段落
  const AUTO_START = '<!-- canvas:auto-start -->';
  const AUTO_END = '<!-- canvas:auto-end -->';
  const autoBlock = `${AUTO_START}\n${context}\n${AUTO_END}`;
  const startIdx = existing.indexOf(AUTO_START);
  const endIdx = existing.indexOf(AUTO_END);
  let updated: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    updated = existing.slice(0, startIdx) + autoBlock + existing.slice(endIdx + AUTO_END.length);
  } else {
    updated = existing.trimEnd()
      ? `${existing.trimEnd()}\n\n${autoBlock}\n`
      : `${autoBlock}\n`;
  }
  await fileApi.write(`${canvasDir}/AGENTS.md`, updated);
};

/** 生成写入 cwd/AGENTS.md 的轻量指针段落。 */
const buildPointerSection = (canvasDir: string, wsId: string, label: string): string =>
  [
    `## Canvas Workspace (${label})`,
    '',
    `Canvas agent config: \`${canvasDir}/AGENTS.md\``,
    '',
    '> 读取上方文件获取画布结构、笔记列表和 Agent 指令。',
    '',
  ].join('\n');

const writeCanvasContext = async (
  nodes: CanvasNode[],
  cwd: string,
  workspaceId?: string,
  workspaceName?: string,
  term?: Terminal,
) => {
  const storeApi = window.canvasWorkspace?.store;
  const fileApi = window.canvasWorkspace?.file;
  if (!storeApi || !fileApi) return;

  const wsId = workspaceId ?? 'default';

  // getDir 在主进程会自动 mkdir + 初始化 AGENTS.md，目录不存在时新建
  const dirRes = await storeApi.getDir(wsId);
  if (!dirRes.ok) return;
  const canvasDir: string = dirRes.dir;

  const context = buildCanvasContext(nodes, cwd, workspaceId, workspaceName, canvasDir);
  if (!context) return;

  const label = workspaceName
    ? `${workspaceName}${workspaceId ? ` (${workspaceId})` : ''}`
    : wsId;

  // 1. 完整 context 写入 canvas 目录下的 AGENTS.md
  await writeCanvasAgentsMd(fileApi, canvasDir, context);

  // 2. cwd 下只写轻量指针
  const pointer = buildPointerSection(canvasDir, wsId, label);
  const [claudeRead, agentsRead] = await Promise.all([
    fileApi.read(`${cwd}/CLAUDE.md`),
    fileApi.read(`${cwd}/AGENTS.md`),
  ]);
  const claudeContent = upsertSection(claudeRead.ok ? (claudeRead.content ?? '') : '', wsId, pointer);
  const agentsContent = upsertSection(agentsRead.ok ? (agentsRead.content ?? '') : '', wsId, pointer);
  await Promise.all([
    fileApi.write(`${cwd}/CLAUDE.md`, claudeContent),
    fileApi.write(`${cwd}/AGENTS.md`, agentsContent),
  ]);

  if (term) {
    const action = (ok: boolean) => ok ? 'updated' : 'created';
    term.writeln(
      `\x1b[2m[canvas] canvas/AGENTS.md updated · CLAUDE.md ${action(claudeRead.ok)} / AGENTS.md ${action(agentsRead.ok)}\x1b[0m`
    );
  }
};

const serializeBuffer = (term: Terminal): string => {
  const buf = term.buffer.active;
  const lines: string[] = [];
  const count = buf.length;
  for (let i = 0; i < count; i++) {
    const line = buf.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  let text = lines.join("\n");
  text = text.replace(/\n+$/, "");
  if (text.length > MAX_SCROLLBACK_CHARS) {
    text = text.slice(-MAX_SCROLLBACK_CHARS);
  }
  return text;
};

export const TerminalNodeBody = ({ node, allNodes, rootFolder, workspaceId, workspaceName, onUpdate }: Props) => {
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
  const initialScrollback = useRef(data.scrollback ?? "");
  const initialCwd = useRef(data.cwd ?? "");

  const persistState = useCallback(() => {
    const term = termRef.current;
    const scrollback = term
      ? serializeBuffer(term)
      : dataRef.current.scrollback;
    onUpdateRef.current(nodeIdRef.current, {
      data: {
        sessionId: dataRef.current.sessionId,
        scrollback,
        cwd: dataRef.current.cwd
      }
    });
  }, []);

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || termRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new Terminal({
      fontSize: 12,
      lineHeight: 1.4,
      letterSpacing: 0,
      fontFamily: "'SF Mono', 'Fira Code', Menlo, 'Cascadia Code', monospace",
      theme: {
        background: "#fafaf9",
        foreground: "#37352f",
        cursor: "#37352f",
        cursorAccent: "#fafaf9",
        selectionBackground: "rgba(35, 131, 226, 0.15)",
        selectionForeground: "#37352f",
        black: "#37352f",
        red: "#eb5757",
        green: "#0f7b6c",
        yellow: "#d9730d",
        blue: "#2383e2",
        magenta: "#9065b0",
        cyan: "#0f7b6c",
        white: "#787774",
        brightBlack: "#787774",
        brightRed: "#eb5757",
        brightGreen: "#0f7b6c",
        brightYellow: "#d9730d",
        brightBlue: "#2383e2",
        brightMagenta: "#9065b0",
        brightCyan: "#0f7b6c",
        brightWhite: "#37352f"
      },
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      scrollback: 5000,
      smoothScrollDuration: 100
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    if (initialScrollback.current) {
      const RESTORE_TAIL_LINES = 10;
      const lastLines = initialScrollback.current
        .split("\n")
        .slice(-RESTORE_TAIL_LINES)
        .join("\r\n");
      term.writeln("\x1b[2m--- session restored ---\x1b[0m");
      term.write(lastLines + "\r\n");
      term.writeln("\x1b[2m--- new session ---\x1b[0m\r\n");
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });

    const api = window.canvasWorkspace?.pty;
    if (!api) {
      term.writeln(
        "\x1b[31mError: pty API not available (preload missing)\x1b[0m"
      );
      return;
    }

    const spawnCwd = initialCwd.current || rootFolder || undefined;

    const result = await api.spawn(sessionId, term.cols, term.rows, spawnCwd);
    if (!result.ok) {
      term.writeln(`\x1b[31mFailed to spawn shell: ${result.error}\x1b[0m`);
      return;
    }

    const removeData = api.onData(sessionId, (d: string) => {
      term.write(d);
    });

    const removeExit = api.onExit(sessionId, (code: number) => {
      term.writeln(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m`);
    });

    // Track user input to detect AI tool commands (claude / codex / pulse-coder)
    // and lazily inject canvas context into CLAUDE.md / AGENTS.md only then.
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

    term.onResize(({ cols, rows }) => {
      api.resize(sessionId, cols, rows);
    });

    // Periodically save scrollback + cwd
    saveTimerRef.current = setInterval(async () => {
      const scrollback = serializeBuffer(term);
      const cwdResult = await api.getCwd(sessionId);
      const cwd =
        cwdResult.ok && cwdResult.cwd ? cwdResult.cwd : dataRef.current.cwd;
      onUpdateRef.current(nodeIdRef.current, {
        data: { sessionId: dataRef.current.sessionId, scrollback, cwd }
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
      // Save final state
      const api = window.canvasWorkspace?.pty;
      if (termRef.current && api) {
        const scrollback = serializeBuffer(termRef.current);
        void api.getCwd(sessionId).then((r) => {
          const cwd =
            r.ok && r.cwd ? r.cwd : dataRef.current.cwd;
          onUpdateRef.current(nodeIdRef.current, {
            data: {
              sessionId: dataRef.current.sessionId,
              scrollback,
              cwd
            }
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
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="terminal-body-wrap">
      <div
        ref={containerRef}
        className="terminal-xterm-container"
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
};

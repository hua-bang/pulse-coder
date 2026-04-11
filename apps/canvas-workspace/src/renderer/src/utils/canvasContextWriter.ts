import type { CanvasNode, FileNodeData } from '../types';
import type { Terminal } from '@xterm/xterm';

const extractDescription = (content: string): string => {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) return heading[1];
    if (/^[-*_]{3,}$/.test(line)) continue;
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
    '# Pulse Canvas Context',
    '',
    `Workspace: ${label}`,
    `Folder: ${workspaceFolder}`,
  ];

  if (workspaceId) {
    lines.push('', '## Workspace Isolation');
    lines.push('', `Environment variable \`PULSE_CANVAS_WORKSPACE_ID=${workspaceId}\` is injected into this terminal session.`);
    lines.push('Use this to scope all canvas operations to the current workspace and avoid reading/writing nodes from other canvases.');
    lines.push('When calling MCP canvas tools, always pass this workspace ID to ensure isolation.');
  }

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
export const AI_TOOL_PATTERN = /\b(claude|codex|pulse-coder|pulsecoder)\b/;

const writeCanvasAgentsMd = async (
  fileApi: NonNullable<typeof window.canvasWorkspace>['file'],
  canvasDir: string,
  context: string,
): Promise<void> => {
  const existing = await fileApi.read(`${canvasDir}/AGENTS.md`).then(r => (r.ok ? r.content ?? '' : ''));
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

const buildPointerSection = (canvasDir: string, wsId: string, label: string): string => {
  const lines = [
    `## Pulse Canvas (${label})`,
    '',
    `Canvas agent config: \`${canvasDir}/AGENTS.md\``,
    '',
    '> 读取上方文件获取画布结构、笔记列表和 Agent 指令。',
    '',
    `**Workspace Isolation:** Environment variable \`PULSE_CANVAS_WORKSPACE_ID=${wsId}\` is injected into this terminal.`,
    'Always use this workspace ID when calling canvas MCP tools to avoid cross-canvas reads/writes.',
    '',
  ];
  return lines.join('\n');
};

export const writeCanvasContext = async (
  nodes: CanvasNode[],
  cwd: string,
  workspaceId?: string,
  workspaceName?: string,
  term?: Terminal,
): Promise<void> => {
  const storeApi = window.canvasWorkspace?.store;
  const fileApi = window.canvasWorkspace?.file;
  if (!storeApi || !fileApi) return;

  const wsId = workspaceId ?? 'default';

  const dirRes = await storeApi.getDir(wsId);
  if (!dirRes.ok || !dirRes.dir) return;
  const canvasDir: string = dirRes.dir;

  const context = buildCanvasContext(nodes, cwd, workspaceId, workspaceName, canvasDir);
  if (!context) return;

  const label = workspaceName
    ? `${workspaceName}${workspaceId ? ` (${workspaceId})` : ''}`
    : wsId;

  await writeCanvasAgentsMd(fileApi, canvasDir, context);

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

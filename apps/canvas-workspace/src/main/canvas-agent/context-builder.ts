/**
 * Context builder for the Canvas Agent.
 *
 * Produces a lightweight workspace summary (always injected into system prompt)
 * and a detailed context (loaded on demand via canvas_read_context tool).
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EdgeSummary, NodeSummary, WorkspaceSummary } from './types';
import { getNodeRenderedText } from '../webview-registry';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

interface CanvasNode {
  id: string;
  type: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
  updatedAt?: number;
}

type EdgeAnchor = 'top' | 'right' | 'bottom' | 'left' | 'auto';

type EdgeEndpoint =
  | { kind: 'node'; nodeId: string; anchor?: EdgeAnchor }
  | { kind: 'point'; x: number; y: number };

interface CanvasEdge {
  id: string;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  bend?: number;
  arrowHead?: string;
  arrowTail?: string;
  stroke?: { color?: string; width?: number; style?: string };
  label?: string;
  kind?: string;
  payload?: Record<string, unknown>;
  updatedAt?: number;
}

interface CanvasSaveData {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  transform: { x: number; y: number; scale: number };
  savedAt: string;
}

interface WorkspaceManifest {
  workspaces: Array<{ id: string; name: string }>;
  activeId?: string;
}

// ─── Web page fetching (for iframe / link nodes) ───────────────────

const PAGE_FETCH_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 200_000;

/**
 * Fetch a web page and return its readable text content. Strips
 * `<script>`, `<style>`, and `<noscript>` blocks, drops remaining HTML
 * tags, and collapses whitespace so the LLM sees the prose.
 *
 * Fails gracefully: a network error or non-2xx response returns a short
 * error string instead of throwing, so the agent can surface a useful
 * message to the user.
 */
async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (PulseCoder Canvas Agent)',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    if (!res.ok) {
      return `[fetch failed: HTTP ${res.status} ${res.statusText}]`;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();

    // Cap by bytes (approx) to avoid blowing up the context.
    const truncated = raw.length > PAGE_MAX_BYTES;
    const body = truncated ? raw.slice(0, PAGE_MAX_BYTES) : raw;

    let text = body;
    if (contentType.includes('html') || /<[a-z!/]/i.test(body)) {
      // Try to grab <title> for a nicer summary header.
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
      const title = titleMatch ? titleMatch[1].trim() : '';

      text = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        // Decode a minimal set of HTML entities — enough for readability.
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();

      if (title) text = `Title: ${title}\n\n${text}`;
    }

    if (truncated) text += '\n\n[…content truncated]';
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      return `[fetch timed out after ${PAGE_FETCH_TIMEOUT_MS / 1000}s]`;
    }
    return `[fetch failed: ${msg}]`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the text content of an iframe/link node.
 *
 * Prefers the live webview DOM (what the user is actually seeing, with JS
 * executed and login cookies applied) and falls back to a fresh server-side
 * HTTP fetch when the webview isn't mounted — e.g. the workspace isn't open
 * in the foreground window, or the page hasn't finished attaching yet.
 *
 * Never returns an empty string: each failure path returns a bracketed
 * diagnostic so the agent can tell the user *why* it couldn't read the
 * page (SPA with no static HTML, auth-gated, webview not attached, etc.)
 * instead of silently producing empty content.
 */
async function readIframeContent(
  workspaceId: string,
  nodeId: string,
  url: string,
): Promise<string> {
  if (!url) return '[empty link node — no URL set]';

  let liveError: string | null = null;
  try {
    const live = await getNodeRenderedText(workspaceId, nodeId);
    if (live && live.trim()) return live;
    if (live !== null) {
      // getNodeRenderedText returned a diagnostic like a timeout — keep it
      // so we can surface it if the server fetch also fails to help.
      liveError = live.trim() ? live : null;
    } else {
      liveError = '[live webview not registered — node may not be mounted in the foreground window, or webviewTag is off (a full Electron restart is required for that flag to take effect)]';
    }
  } catch (err) {
    liveError = `[live webview read failed: ${err instanceof Error ? err.message : String(err)}]`;
  }

  const fetched = await fetchPageText(url);
  if (fetched.trim()) return fetched;

  // Both paths produced nothing readable. Tell the agent precisely why so
  // it can explain to the user instead of pretending the page is empty.
  return [
    '[canvas_read_node could not extract text from this link node]',
    '- Tried the live webview first:',
    `  ${liveError ?? '(succeeded but returned empty text — the page may still be loading)'}`,
    '- Then tried a plain server fetch:',
    '  Succeeded with no readable text — the page is almost certainly a JS-rendered SPA (React/Vue) whose content only exists after scripts run.',
    '',
    'To summarise this page, open it in a Link node on the canvas, wait for it to finish loading (log in if needed), then ask again. If it still fails, ask the user to paste the text directly.',
  ].join('\n');
}

// ─── Low-level readers ─────────────────────────────────────────────

async function loadCanvasJson(workspaceId: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, workspaceId, 'canvas.json'), 'utf-8');
    return JSON.parse(raw) as CanvasSaveData;
  } catch {
    return null;
  }
}

async function loadManifest(): Promise<WorkspaceManifest> {
  try {
    const raw = await fs.readFile(join(STORE_DIR, '__workspaces__.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const workspaces = (parsed.workspaces ?? parsed.entries ?? []) as WorkspaceManifest['workspaces'];
    return { workspaces, activeId: parsed.activeId as string | undefined };
  } catch {
    return { workspaces: [] };
  }
}

/**
 * Resolve a set of workspaceIds to `{ id, name }` pairs using the on-disk
 * manifest. IDs that don't exist in the manifest still come back, with their
 * name falling back to the ID itself so the caller can always reference them.
 */
export async function resolveWorkspaceNames(
  workspaceIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (workspaceIds.length === 0) return [];
  const manifest = await loadManifest();
  const byId = new Map(manifest.workspaces.map(w => [w.id, w.name] as const));
  return workspaceIds.map(id => ({ id, name: byId.get(id) ?? id }));
}

// ─── Summary builder ───────────────────────────────────────────────

/**
 * Text nodes have no editable title — the prose lives in `data.content`.
 * Pull a short preview so the agent sees something meaningful instead of
 * an empty string when it lists the canvas contents.
 */
function textNodePreview(content: string | undefined, maxChars = 40): string {
  if (!content) return '';
  const firstLine = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstLine) return '';
  const stripped = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
  if (!stripped) return '';
  return stripped.length <= maxChars ? stripped : `${stripped.slice(0, maxChars)}…`;
}

// ─── Mindmap helpers ───────────────────────────────────────────────

interface MindmapTopic {
  id: string;
  text: string;
  children?: MindmapTopic[];
  collapsed?: boolean;
}

/** Count every topic in the tree, root included. */
function countMindmapTopics(topic: MindmapTopic | undefined): number {
  if (!topic) return 0;
  let n = 1;
  for (const child of topic.children ?? []) n += countMindmapTopics(child);
  return n;
}

/**
 * Flatten a mindmap tree into an indented bullet list so the agent can
 * read the structure as plain text. Marks collapsed branches but still
 * walks them — the agent should see the content even if the user hid it
 * in the UI.
 */
function flattenMindmapTopics(topic: MindmapTopic | undefined, depth = 0): string {
  if (!topic) return '';
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  const text = topic.text?.trim() || '(empty topic)';
  const collapsedHint = topic.collapsed ? ' [collapsed in UI]' : '';
  lines.push(`${indent}- ${text}${collapsedHint}`);
  for (const child of topic.children ?? []) {
    lines.push(flattenMindmapTopics(child, depth + 1));
  }
  return lines.join('\n');
}

function summarizeNode(node: CanvasNode): NodeSummary {
  const summary: NodeSummary = {
    id: node.id,
    type: node.type,
    title: node.title,
  };

  switch (node.type) {
    case 'file':
      summary.path = (node.data.filePath as string) || undefined;
      break;
    case 'terminal':
      summary.path = (node.data.cwd as string) || undefined;
      break;
    case 'agent':
      summary.path = (node.data.cwd as string) || undefined;
      summary.agentType = (node.data.agentType as string) || 'claude-code';
      summary.status = (node.data.status as string) || 'idle';
      break;
    case 'frame':
      summary.color = (node.data.color as string) || undefined;
      summary.label = (node.data.label as string) || undefined;
      break;
    case 'image':
      summary.imagePath = (node.data.filePath as string) || undefined;
      break;
    case 'iframe': {
      const iframeMode = (node.data.mode as string) || 'url';
      if (iframeMode === 'html' || iframeMode === 'ai') {
        summary.url = undefined;
      } else {
        summary.url = (node.data.url as string) || undefined;
      }
      break;
    }
    case 'text':
      // Text nodes don't have titles — fall back to a content preview so
      // the agent can refer to them by something meaningful.
      if (!summary.title) {
        summary.title = textNodePreview(node.data.content as string) || 'Text';
      }
      break;
    case 'mindmap': {
      // Mindmap nodes carry a topic tree under data.root. The on-canvas
      // title is always "Mindmap" — useless for the agent — so fall back
      // to the root topic's text.
      const root = node.data.root as MindmapTopic | undefined;
      const rootText = root?.text?.trim();
      if (rootText) summary.rootText = rootText;
      summary.topicCount = countMindmapTopics(root);
      if (!summary.title || summary.title === 'Mindmap') {
        summary.title = rootText || 'Mindmap';
      }
      break;
    }
  }

  return summary;
}

/**
 * Resolve a single endpoint into a "[nodeId] "Title"" / "point(x, y)"
 * snippet used by the Connections block in the prompt. When the target
 * node is missing (e.g. deleted) we fall back to the raw id so the
 * agent can still reason about the reference.
 */
function describeEndpoint(
  endpoint: CanvasEdge['source'],
  nodesById: Map<string, CanvasNode>,
): string {
  if (endpoint.kind === 'point') {
    return `point(${Math.round(endpoint.x)}, ${Math.round(endpoint.y)})`;
  }
  const node = nodesById.get(endpoint.nodeId);
  if (!node) return `[${endpoint.nodeId}] (missing)`;
  const title = node.title && node.title.trim().length > 0 ? node.title : node.type;
  return `[${node.id}] "${title}"`;
}

/**
 * Turn a raw edge into its prompt-facing summary. The string form is
 * what the formatter prints; the raw node IDs are kept alongside it so
 * the agent can invoke edge tools or `canvas_read_node` without needing
 * to re-resolve the reference itself.
 */
function summarizeEdge(edge: CanvasEdge, nodesById: Map<string, CanvasNode>): EdgeSummary {
  const summary: EdgeSummary = {
    id: edge.id,
    source: describeEndpoint(edge.source, nodesById),
    target: describeEndpoint(edge.target, nodesById),
  };
  if (edge.source.kind === 'node') summary.sourceNodeId = edge.source.nodeId;
  if (edge.target.kind === 'node') summary.targetNodeId = edge.target.nodeId;
  if (edge.label) summary.label = edge.label;
  if (edge.kind) summary.kind = edge.kind;
  return summary;
}

/**
 * Build a lightweight workspace summary. This is cheap and always injected
 * into the Canvas Agent's system prompt so it "knows what's on the canvas".
 */
export async function buildWorkspaceSummary(workspaceId: string): Promise<WorkspaceSummary | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const manifest = await loadManifest();
  const entry = manifest.workspaces.find(e => e.id === workspaceId);
  const workspaceName = entry?.name ?? workspaceId;
  const canvasDir = join(STORE_DIR, workspaceId);

  const nodesById = new Map(canvas.nodes.map((n) => [n.id, n]));
  const edges = Array.isArray(canvas.edges) ? canvas.edges : [];

  return {
    workspaceId,
    workspaceName,
    canvasDir,
    nodeCount: canvas.nodes.length,
    nodes: canvas.nodes.map(summarizeNode),
    edges: edges.length > 0 ? edges.map((e) => summarizeEdge(e, nodesById)) : undefined,
  };
}

// ─── Detailed context (on-demand) ──────────────────────────────────

interface DetailedNodeContext extends NodeSummary {
  content?: string;
  scrollback?: string;
  cwd?: string;
}

interface DetailedWorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  canvasDir: string;
  nodes: DetailedNodeContext[];
  agentsMd?: string;
}

/**
 * Build a full detailed context including file contents and terminal
 * scrollback. This is expensive and only loaded via the canvas_read_context
 * tool when the agent needs deep context.
 */
export async function buildDetailedContext(workspaceId: string): Promise<DetailedWorkspaceContext | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const manifest = await loadManifest();
  const entry = manifest.workspaces.find(e => e.id === workspaceId);
  const workspaceName = entry?.name ?? workspaceId;
  const canvasDir = join(STORE_DIR, workspaceId);

  const nodes: DetailedNodeContext[] = [];

  for (const node of canvas.nodes) {
    const base = summarizeNode(node);
    const detailed: DetailedNodeContext = { ...base };

    switch (node.type) {
      case 'file': {
        const filePath = node.data.filePath as string;
        if (filePath) {
          try {
            detailed.content = await fs.readFile(filePath, 'utf-8');
          } catch {
            detailed.content = (node.data.content as string) ?? '';
          }
        } else {
          detailed.content = (node.data.content as string) ?? '';
        }
        break;
      }
      case 'terminal':
        detailed.scrollback = (node.data.scrollback as string) ?? '';
        detailed.cwd = (node.data.cwd as string) ?? '';
        break;
      case 'agent':
        detailed.scrollback = (node.data.scrollback as string) ?? '';
        detailed.cwd = (node.data.cwd as string) ?? '';
        break;
      case 'image':
        detailed.content = node.data.filePath ? `[image file: ${node.data.filePath as string}]` : '[image node has no filePath]';
        break;
      case 'iframe': {
        const iframeMode = (node.data.mode as string) || 'url';
        if (iframeMode === 'html' || iframeMode === 'ai') {
          detailed.content = (node.data.html as string) ?? '';
        } else {
          const url = (node.data.url as string) || '';
          detailed.content = await readIframeContent(workspaceId, node.id, url);
        }
        break;
      }
      case 'text':
        detailed.content = (node.data.content as string) ?? '';
        break;
      case 'mindmap': {
        const root = node.data.root as MindmapTopic | undefined;
        detailed.content = root ? flattenMindmapTopics(root) : '';
        break;
      }
    }

    nodes.push(detailed);
  }

  // Read AGENTS.md if present
  let agentsMd: string | undefined;
  try {
    agentsMd = await fs.readFile(join(canvasDir, 'AGENTS.md'), 'utf-8');
  } catch {
    // not present
  }

  return { workspaceId, workspaceName, canvasDir, nodes, agentsMd };
}

// ─── Read a single node in detail ──────────────────────────────────

export async function readNodeDetail(workspaceId: string, nodeId: string): Promise<DetailedNodeContext | null> {
  const canvas = await loadCanvasJson(workspaceId);
  if (!canvas) return null;

  const node = canvas.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const base = summarizeNode(node);
  const detailed: DetailedNodeContext = { ...base };

  switch (node.type) {
    case 'file': {
      const filePath = node.data.filePath as string;
      if (filePath) {
        try {
          detailed.content = await fs.readFile(filePath, 'utf-8');
        } catch {
          detailed.content = (node.data.content as string) ?? '';
        }
      } else {
        detailed.content = (node.data.content as string) ?? '';
      }
      break;
    }
    case 'terminal':
      detailed.scrollback = (node.data.scrollback as string) ?? '';
      detailed.cwd = (node.data.cwd as string) ?? '';
      break;
    case 'agent':
      detailed.scrollback = (node.data.scrollback as string) ?? '';
      detailed.cwd = (node.data.cwd as string) ?? '';
      break;
    case 'frame':
      // nothing extra beyond summary
      break;
    case 'image':
      detailed.content = node.data.filePath ? `[image file: ${node.data.filePath as string}]` : '[image node has no filePath]';
      break;
    case 'iframe': {
      const iframeMode = (node.data.mode as string) || 'url';
      if (iframeMode === 'html' || iframeMode === 'ai') {
        detailed.content = (node.data.html as string) ?? '';
      } else {
        // Use the same live-webview-first path as buildDetailedContext so a
        // single-node read (the common case for `@Link 总结`) can see the
        // post-JS DOM — otherwise SPAs like Lark wiki come back as empty-ish
        // shell HTML and the agent gets `content: ""`.
        const url = (node.data.url as string) || '';
        detailed.content = await readIframeContent(workspaceId, node.id, url);
      }
      break;
    }
    case 'text':
      detailed.content = (node.data.content as string) ?? '';
      break;
    case 'mindmap': {
      const root = node.data.root as MindmapTopic | undefined;
      detailed.content = root ? flattenMindmapTopics(root) : '';
      break;
    }
  }

  return detailed;
}

// ─── Format summary as system prompt section ───────────────────────

export function formatSummaryForPrompt(summary: WorkspaceSummary): string {
  const lines: string[] = [
    `# Canvas Workspace: ${summary.workspaceName}`,
    `Workspace ID: ${summary.workspaceId}`,
    `Canvas directory: ${summary.canvasDir}`,
    `Total nodes: ${summary.nodeCount}`,
    '',
  ];

  const byType: Record<string, NodeSummary[]> = {};
  for (const node of summary.nodes) {
    (byType[node.type] ??= []).push(node);
  }

  if (byType.file?.length) {
    lines.push('## File Nodes');
    for (const n of byType.file) {
      const pathHint = n.path ? ` (${n.path})` : ' (unsaved)';
      lines.push(`- [${n.id}] **${n.title}**${pathHint}`);
    }
    lines.push('');
  }

  if (byType.frame?.length) {
    lines.push('## Frames');
    for (const n of byType.frame) {
      const labelHint = n.label ? ` — ${n.label}` : '';
      lines.push(`- [${n.id}] **${n.title}**${labelHint}`);
    }
    lines.push('');
  }

  if (byType.terminal?.length) {
    lines.push('## Terminals');
    for (const n of byType.terminal) {
      const cwdHint = n.path ? ` (cwd: ${n.path})` : '';
      lines.push(`- [${n.id}] **${n.title}**${cwdHint}`);
    }
    lines.push('');
  }

  if (byType.agent?.length) {
    lines.push('## Agent Nodes');
    for (const n of byType.agent) {
      const info = `${n.agentType ?? 'unknown'}, ${n.status ?? 'idle'}`;
      const cwdHint = n.path ? `, cwd: ${n.path}` : '';
      lines.push(`- [${n.id}] **${n.title}** (${info}${cwdHint})`);
    }
    lines.push('');
  }

  if (byType.iframe?.length) {
    lines.push('## Link Nodes');
    for (const n of byType.iframe) {
      const hint = n.url ? ` — ${n.url}` : ' (HTML)';
      lines.push(`- [${n.id}] **${n.title}**${hint}`);
    }
    lines.push('');
  }

  if (byType.image?.length) {
    lines.push('## Image Nodes');
    lines.push('_Use `canvas_analyze_image` with the node id to read/OCR image contents._');
    for (const n of byType.image) {
      const pathHint = n.imagePath ? ` (${n.imagePath})` : '';
      lines.push(`- [${n.id}] **${n.title}**${pathHint}`);
    }
    lines.push('');
  }

  if (byType.text?.length) {
    lines.push('## Text Nodes');
    for (const n of byType.text) {
      lines.push(`- [${n.id}] **${n.title}**`);
    }
    lines.push('');
  }

  if (byType.mindmap?.length) {
    lines.push('## Mindmaps');
    lines.push(
      '_Tree of topics rooted at the listed text. Use `canvas_read_node` to ' +
      'get the full indented topic tree._',
    );
    for (const n of byType.mindmap) {
      const countHint = n.topicCount ? ` (${n.topicCount} topics)` : '';
      lines.push(`- [${n.id}] **${n.title}**${countHint}`);
    }
    lines.push('');
  }

  if (summary.edges?.length) {
    lines.push('## Connections');
    lines.push(
      '_Arrows the user has drawn between (or around) nodes. Treat them as ' +
      'semantic hints: "A → B" usually means A informs, depends on, or flows into B._',
    );
    for (const e of summary.edges) {
      const labelHint = e.label ? ` — "${e.label}"` : '';
      const kindHint = e.kind ? ` [${e.kind}]` : '';
      lines.push(`- [${e.id}] ${e.source} → ${e.target}${labelHint}${kindHint}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

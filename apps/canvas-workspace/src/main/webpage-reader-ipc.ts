/**
 * webpage-reader-ipc — reads a webpage that is already open in a canvas iframe node.
 *
 * Only operates on webviews already registered in the webview-registry — i.e.
 * iframe/link canvas nodes whose <webview> is currently mounted and loaded.
 * For reading arbitrary URLs use the existing jina_ai_read / tavily tools.
 *
 * Strategy cascade (default: auto = dom → a11y → screenshot):
 *   1. dom        — executeJavaScript innerText.  Safe on any webContents; returns
 *                   the fully-rendered text the user is looking at right now.
 *   2. a11y       — CDP Accessibility.getFullAXTree.  Richer semantic structure
 *                   (roles, names, descriptions).  Falls back if CDP attach fails.
 *   3. screenshot — capturePage() → base64 PNG data URL, ready for vision models.
 *                   Captures the exact viewport the user sees.
 *
 * All strategies operate on the *live* webContents — no extra network request,
 * no re-render, current auth/session state preserved.
 */

import { ipcMain } from 'electron';
import { tmpdir } from 'os';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { getWebContentsForNode } from './webview-registry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTRACT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SPARSE_THRESHOLD = 200;

// ---------------------------------------------------------------------------
// Strategy implementations  (all take a live WebContents)
// ---------------------------------------------------------------------------

export type AnyWebContents = NonNullable<ReturnType<typeof getWebContentsForNode>>;

export async function readDOM(
  wc: AnyWebContents,
  maxChars: number,
): Promise<{ ok: boolean; text: string; title: string; url: string; error?: string }> {
  const script = `
    (function () {
      try {
        return {
          ok: true,
          title: document.title || '',
          text: document.body ? (document.body.innerText || document.body.textContent || '') : '',
          url: location.href,
        };
      } catch (err) {
        return { ok: false, title: '', text: '', url: '', error: String(err) };
      }
    })();
  `;

  try {
    const raw = await Promise.race([
      wc.executeJavaScript(script, false) as Promise<{
        ok: boolean; title: string; text: string; url: string; error?: string;
      }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DOM extraction timed out')), EXTRACT_TIMEOUT_MS),
      ),
    ]);

    if (!raw.ok) return { ok: false, text: '', title: '', url: '', error: raw.error };

    const cleaned = (raw.text ?? '').replace(/\s+/g, ' ').trim();
    const truncated = maxChars > 0 && cleaned.length > maxChars;
    const text = truncated ? cleaned.slice(0, maxChars) + '\n\n[…content truncated]' : cleaned;

    return { ok: true, text, title: raw.title, url: raw.url };
  } catch (err) {
    return { ok: false, text: '', title: '', url: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Flatten an AX node tree into indented readable text. */
function flattenA11yNodes(
  nodes: Array<{
    nodeId: string;
    role?: { value?: string };
    name?: { value?: string };
    description?: { value?: string };
    value?: { value?: string };
    childIds?: string[];
  }>,
  idMap: Map<string, (typeof nodes)[number]>,
  nodeId: string,
  depth = 0,
  lines: string[] = [],
): string[] {
  const node = idMap.get(nodeId);
  if (!node) return lines;

  const role = node.role?.value ?? '';
  const name = node.name?.value?.trim() ?? '';
  const desc = node.description?.value?.trim() ?? '';
  const val = node.value?.value?.trim() ?? '';

  if (role && role !== 'none' && role !== 'unknown' && role !== 'generic') {
    const parts: string[] = [role];
    if (name) parts.push(`"${name}"`);
    if (desc) parts.push(`(${desc})`);
    if (val) parts.push(`= ${val}`);
    lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
  }

  for (const childId of node.childIds ?? []) {
    flattenA11yNodes(nodes, idMap, childId, depth + 1, lines);
  }

  return lines;
}

export async function readA11y(
  wc: AnyWebContents,
): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Accessibility.enable');

    const result = await Promise.race([
      wc.debugger.sendCommand('Accessibility.getFullAXTree') as Promise<{
        nodes: Array<{
          nodeId: string;
          role?: { value?: string };
          name?: { value?: string };
          description?: { value?: string };
          value?: { value?: string };
          childIds?: string[];
        }>;
      }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('a11y extraction timed out')), EXTRACT_TIMEOUT_MS),
      ),
    ]);

    wc.debugger.detach();

    const { nodes } = result;
    const idMap = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes[0];
    const lines = root ? flattenA11yNodes(nodes, idMap, root.nodeId) : [];
    return { ok: true, text: lines.join('\n') || '(empty a11y tree)' };
  } catch (err) {
    // Best-effort detach in case we attached before the error.
    try { wc.debugger.detach(); } catch { /* ignore */ }
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function captureScreenshot(
  wc: AnyWebContents,
): Promise<{ ok: boolean; imagePath: string; error?: string }> {
  let debuggerAttached = false;
  try {
    wc.debugger.attach('1.3');
    debuggerAttached = true;

    // captureBeyondViewport:true without a clip captures the full scrollable
    // document — same technique used by Puppeteer's fullPage:true screenshot.
    // No viewport override needed → zero layout reflow, zero visual impact.
    const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    }) as { data: string };

    wc.debugger.detach();
    debuggerAttached = false;

    const imagePath = `${tmpdir()}/pulse-screenshot-${randomUUID()}.png`;
    await fs.writeFile(imagePath, Buffer.from(result.data, 'base64'));
    return { ok: true, imagePath };
  } catch (err) {
    if (debuggerAttached) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
    return { ok: false, imagePath: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// IPC payload types
// ---------------------------------------------------------------------------

export type WebReadStrategy = 'auto' | 'dom' | 'a11y' | 'screenshot';

export interface WebReadInput {
  workspaceId: string;
  nodeId: string;
  strategy?: WebReadStrategy;
  /** Max characters for DOM text extraction. Defaults to 12 000. */
  maxChars?: number;
  /**
   * In auto mode, minimum extracted text length to be considered "useful"
   * before trying the next strategy. Defaults to 200.
   */
  sparseThreshold?: number;
}

export type WebReadResult =
  | { ok: true;  nodeId: string; strategy: 'dom';        text: string; title: string; url: string }
  | { ok: true;  nodeId: string; strategy: 'a11y';       text: string }
  | { ok: true;  nodeId: string; strategy: 'screenshot'; imagePath: string }
  | { ok: false; nodeId: string; strategy: WebReadStrategy; error: string };

// ---------------------------------------------------------------------------
// IPC setup
// ---------------------------------------------------------------------------

export function setupWebpageReaderIpc(): void {
  ipcMain.handle(
    'web:read',
    async (_event: unknown, payload: WebReadInput): Promise<WebReadResult> => {
      const { workspaceId, nodeId } = payload ?? {};

      if (!workspaceId || !nodeId) {
        return { ok: false, nodeId: nodeId ?? '', strategy: 'dom', error: 'workspaceId and nodeId are required' };
      }

      const wc = getWebContentsForNode(workspaceId, nodeId);
      if (!wc) {
        return { ok: false, nodeId, strategy: 'dom', error: `No active webview found for node ${workspaceId}::${nodeId}` };
      }

      const strategy: WebReadStrategy = payload.strategy ?? 'auto';
      const maxChars = payload.maxChars ?? DEFAULT_MAX_CHARS;
      const sparseThreshold = payload.sparseThreshold ?? DEFAULT_SPARSE_THRESHOLD;

      // ── DOM ──────────────────────────────────────────────────────────────
      if (strategy === 'dom' || strategy === 'auto') {
        const result = await readDOM(wc, maxChars);
        if (strategy === 'dom') {
          return result.ok
            ? { ok: true, nodeId, strategy: 'dom', text: result.text, title: result.title, url: result.url }
            : { ok: false, nodeId, strategy: 'dom', error: result.error! };
        }
        if (result.ok && result.text.trim().length >= sparseThreshold) {
          return { ok: true, nodeId, strategy: 'dom', text: result.text, title: result.title, url: result.url };
        }
      }

      // ── a11y ─────────────────────────────────────────────────────────────
      if (strategy === 'a11y' || strategy === 'auto') {
        const result = await readA11y(wc);
        if (strategy === 'a11y') {
          return result.ok
            ? { ok: true, nodeId, strategy: 'a11y', text: result.text }
            : { ok: false, nodeId, strategy: 'a11y', error: result.error! };
        }
        if (result.ok && result.text.trim().length >= sparseThreshold) {
          return { ok: true, nodeId, strategy: 'a11y', text: result.text };
        }
      }

      // ── Screenshot ───────────────────────────────────────────────────────
      const result = await captureScreenshot(wc);
      return result.ok
        ? { ok: true, nodeId, strategy: 'screenshot', imagePath: result.imagePath }
        : { ok: false, nodeId, strategy: 'screenshot', error: result.error! };
    },
  );
}

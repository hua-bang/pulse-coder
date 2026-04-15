/**
 * Infographic generation service.
 *
 * A thin one-shot wrapper around the same LLM stack the Canvas Agent uses,
 * with a dedicated system prompt that asks the model to emit a single
 * self-contained HTML document or SVG document. The output is persisted
 * under `{workspaceDir}/infographics/{nodeId}.{html|svg}` so the node is
 * reloadable without re-running the model.
 *
 * We deliberately do NOT call `Engine.run` here — infographic generation
 * has no need for tools, compaction, or the agentic loop, and a one-shot
 * `generateText` gives us cleaner latency + abort semantics.
 */

import { ipcMain, BrowserWindow } from "electron";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const STORE_DIR = join(homedir(), ".pulse-coder", "canvas");

const INFOGRAPHIC_DIR_NAME = "infographics";

/**
 * Maximum response budget for infographic generation. Infographic HTML can
 * be legitimately long (lots of SVG paths, inline data, etc.) but we cap
 * the output so a runaway model doesn't blow up disk or the UI.
 */
const MAX_OUTPUT_TOKENS = 8192;

/** Kept in sync with CanvasAgent — same model env var resolution. */
function resolveModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-4o";
}

function buildProvider() {
  return createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_URL,
  });
}

const HTML_SYSTEM_PROMPT = `You generate self-contained, visually polished HTML infographics.

## Output format
Return **exactly one** complete HTML document, starting with \`<!DOCTYPE html>\`.
Do not wrap the output in markdown fences, prose, or explanations — your entire
response is written to disk and loaded in a sandboxed browser view as-is.

## Constraints
- All CSS must be inline (a single \`<style>\` block in the \`<head>\`).
- All JavaScript must be inline (a single \`<script>\` block) — no external
  scripts, no CDNs, no network fetches. The document must render fully
  offline.
- Do not load remote fonts or images. Inline SVG / base64 data-URIs are fine.
- Keep the document focused on the requested visual; do not add navigation
  bars, footers, or unrelated chrome.
- Use semantic HTML and reasonable accessible colour contrast.

## Sizing (critical)
The document is embedded in a canvas node whose size the user can freely
drag. The viewport you receive *is* the node's inner area — there is no
scrollbar, nothing above or below. You MUST fill it edge-to-edge:

- Reset the page: \`html, body { margin: 0; padding: 0; width: 100%; height: 100%; }\`
  and \`body { box-sizing: border-box; }\`.
- Your outermost container must also be \`width: 100%; height: 100%;\`
  (or use \`position: fixed; inset: 0;\`). Never set a fixed pixel width
  or height on the root — that will leave white bands when the node is
  resized.
- Use flexbox / grid so the primary visual stretches to fill the
  available space. Paddings are fine; fixed outer frames are not.
- Design for a roughly 4:3 starting viewport (~560×420) but assume the
  user will drag it wider or taller. Diagrams should scale (SVG with
  \`viewBox\` + \`width:100%; height:100%\`); cards should reflow.

## Style guidance
- Prefer clear hierarchy, generous whitespace, and legible type.
- When the user asks for a diagram/flowchart, use SVG.
- When the user asks for a data card or widget, use HTML + CSS grid/flex.
- Interactive affordances (hover, click-to-toggle) are encouraged when they
  aid comprehension.`;

const SVG_SYSTEM_PROMPT = `You generate self-contained SVG infographics.

## Output format
Return **exactly one** complete SVG document, starting with
\`<svg xmlns="http://www.w3.org/2000/svg" …>\` and ending with \`</svg>\`.
Do not wrap the output in markdown fences, HTML, prose, or explanations —
your entire response is written to disk and rendered inline as-is.

## Constraints
- Include a \`viewBox\` so the SVG scales cleanly.
- Do not reference external files, images, or fonts.
- Inline \`<style>\` blocks are fine; no \`<script>\` tags.
- Keep the diagram focused on the requested content.

## Style guidance
- Prefer clean geometry, readable labels, and a restrained palette.
- Show structure through arrows, grouping, and whitespace rather than
  decorative fills.`;

function systemPromptFor(kind: "html" | "svg"): string {
  return kind === "svg" ? SVG_SYSTEM_PROMPT : HTML_SYSTEM_PROMPT;
}

/**
 * Drop any accidental markdown fences the model wraps the output in, and
 * trim leading prose before the first `<!DOCTYPE html>` / `<svg`. Most
 * capable models ignore the "no fences" rule occasionally, especially when
 * the user prompt uses code-fenced examples.
 */
function sanitizeOutput(raw: string, kind: "html" | "svg"): string {
  let text = raw.trim();

  // Strip an outer ```html / ```svg / ``` fence if present.
  const fenceMatch = /^```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  if (kind === "html") {
    const docStart = text.search(/<!DOCTYPE\s+html/i);
    if (docStart > 0) text = text.slice(docStart);
    const htmlStart = text.search(/<html[\s>]/i);
    if (docStart < 0 && htmlStart > 0) text = text.slice(htmlStart);
  } else {
    const svgStart = text.search(/<svg[\s>]/i);
    if (svgStart > 0) text = text.slice(svgStart);
    const svgEnd = text.lastIndexOf("</svg>");
    if (svgEnd >= 0) text = text.slice(0, svgEnd + "</svg>".length);
  }

  return text.trim();
}

function infographicDir(workspaceId: string): string {
  return join(STORE_DIR, workspaceId, INFOGRAPHIC_DIR_NAME);
}

function infographicPath(
  workspaceId: string,
  nodeId: string,
  kind: "html" | "svg",
): string {
  return join(infographicDir(workspaceId), `${nodeId}.${kind}`);
}

/**
 * Generate infographic content for a prompt and persist it to disk.
 * Caller is responsible for updating the canvas node's data afterward
 * (filePath, status). We intentionally do NOT mutate canvas.json here —
 * the renderer-side `onUpdate` is the authoritative path for node state.
 */
export async function generateInfographic(params: {
  workspaceId: string;
  nodeId: string;
  prompt: string;
  kind: "html" | "svg";
  abortSignal?: AbortSignal;
}): Promise<{ kind: "html" | "svg"; content: string; filePath: string }> {
  const { workspaceId, nodeId, prompt, kind, abortSignal } = params;

  const provider = buildProvider();
  const model = provider(resolveModel());

  const { text } = await generateText({
    model,
    system: systemPromptFor(kind),
    prompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal,
  });

  const cleaned = sanitizeOutput(text, kind);
  if (!cleaned) {
    throw new Error("model returned empty output");
  }

  const dir = infographicDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = infographicPath(workspaceId, nodeId, kind);
  await fs.writeFile(filePath, cleaned, "utf-8");

  return { kind, content: cleaned, filePath };
}

/** Read a previously-generated infographic file. */
export async function readInfographic(params: {
  workspaceId: string;
  nodeId: string;
  kind: "html" | "svg";
}): Promise<string> {
  const filePath = infographicPath(
    params.workspaceId,
    params.nodeId,
    params.kind,
  );
  return fs.readFile(filePath, "utf-8");
}

/**
 * Track in-flight generations per node so a second "Generate" click on the
 * same node cancels the prior run — otherwise two concurrent LLM calls
 * would race each other to the same file path on disk.
 */
const inFlight = new Map<string, AbortController>();

function inFlightKey(workspaceId: string, nodeId: string): string {
  return `${workspaceId}::${nodeId}`;
}

export function setupInfographicIpc(): void {
  ipcMain.handle(
    "infographic:generate",
    async (
      _event,
      payload: {
        workspaceId: string;
        nodeId: string;
        prompt: string;
        kind?: "html" | "svg";
      },
    ) => {
      const kind = payload.kind ?? "html";
      const key = inFlightKey(payload.workspaceId, payload.nodeId);
      inFlight.get(key)?.abort();

      const controller = new AbortController();
      inFlight.set(key, controller);

      try {
        const result = await generateInfographic({
          workspaceId: payload.workspaceId,
          nodeId: payload.nodeId,
          prompt: payload.prompt,
          kind,
          abortSignal: controller.signal,
        });
        return { ok: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      } finally {
        if (inFlight.get(key) === controller) {
          inFlight.delete(key);
        }
      }
    },
  );

  ipcMain.handle(
    "infographic:read",
    async (
      _event,
      payload: { workspaceId: string; nodeId: string; kind: "html" | "svg" },
    ) => {
      try {
        const content = await readInfographic(payload);
        return { ok: true, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );
}

/**
 * Broadcast a canvas node update to every BrowserWindow.
 *
 * Used by the canvas-agent tool path (where generation happens server-side
 * and the node is created without any renderer round-trip) so the canvas UI
 * refreshes the node without the user having to re-select the workspace.
 * Mirrors the convention used by `canvas-store.ts` and `canvas-agent/tools.ts`.
 */
export function broadcastInfographicUpdate(
  workspaceId: string,
  nodeIds: string[],
): void {
  const payload = {
    type: "canvas:updated" as const,
    workspaceId,
    nodeIds,
    source: "infographic-service" as const,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("canvas:external-update", payload);
  }
}

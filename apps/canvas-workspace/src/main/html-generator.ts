/**
 * Lightweight LLM utility for generating HTML content — with streaming.
 *
 * Used by the Link node's "AI" mode: the user types a prompt and this
 * module calls the configured LLM to produce a self-contained HTML page
 * that is then rendered in a sandboxed `<iframe srcdoc>`.
 *
 * Two APIs:
 *  - `generateHTML(prompt)` — one-shot, returns the full HTML when done.
 *    Used by the Canvas Agent's `canvas_create_node` tool.
 *  - `streamHTML(prompt, onDelta)` — streaming, calls `onDelta` with each
 *    text chunk so the renderer can update the iframe progressively.
 *    Used by the renderer's AI tab for the Claude-Artifacts-style UX.
 */

import { generateText, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const SYSTEM_PROMPT = `You are a world-class frontend developer who creates stunning, production-quality interactive HTML visuals. The user will describe what they want — your job is to make it look incredible.

## Output rules
- Generate a SINGLE self-contained HTML document. No markdown, no explanation — raw HTML only.
- Start with <!DOCTYPE html>.
- Load external libraries from CDN when useful (Chart.js, D3.js, Three.js, Mermaid, etc.).
- The HTML runs inside a sandboxed iframe — it must be fully self-contained.

## Design quality (THIS IS CRITICAL)
You are NOT making a rough prototype. You are making something that looks like it belongs in a polished product.

Typography:
- Use Inter from Google Fonts (\`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">\`).
- Body text 14–16px, headings with clear hierarchy, line-height 1.5–1.6.
- Use font-weight 500/600 for labels and headings, 400 for body.

Color:
- Use a cohesive, modern color palette. Good defaults: slate-50 backgrounds (#f8fafc), slate-700 text (#334155), indigo-500 accents (#6366f1).
- For data visualizations, use a harmonious multi-color palette: #6366f1, #8b5cf6, #ec4899, #f59e0b, #10b981, #3b82f6.
- Never use pure black (#000) for text — use #1e293b or #334155.
- Add subtle borders (#e2e8f0) and shadows (box-shadow: 0 1px 3px rgba(0,0,0,0.1)).

Layout:
- Use CSS Grid or Flexbox. Center content with sensible max-width (640–960px) and padding.
- Add generous whitespace — padding: 24–32px, gaps: 16–24px.
- Use border-radius: 8–12px for cards and containers.

Visual polish:
- Add subtle background gradients (linear-gradient with near-white tones).
- Use transitions on interactive elements (transition: all 0.2s ease).
- Cards should have: background white, border-radius 12px, subtle shadow, padding 20–24px.
- Tables: alternating row colors, rounded corners, no harsh borders.
- Charts: smooth animations, tooltips on hover, clear legends.

Interactivity:
- Add hover effects on clickable elements (opacity, shadow, scale transforms).
- Smooth CSS transitions everywhere.
- For charts, add animations on load.

## Structure for progressive rendering
- <style> in <head> FIRST — styles render before content appears.
- Content HTML in <body> NEXT — layout builds up progressively.
- <script> at the VERY END of <body> — scripts execute after content is visible.
- This lets the page "grow" visually: styles → structure → interactivity.

## Common patterns
- Dashboard: use CSS Grid with cards, each card has a title, value, and optional sparkline.
- Charts: prefer Chart.js (simple) or D3 (complex). Always add animations and tooltips.
- Tables: zebra striping, sticky header, rounded container.
- Flowcharts/diagrams: use SVG with clean lines and labeled nodes.
- Forms: well-spaced inputs with focus rings, clear labels, modern button styles.`;

function getProvider() {
  return createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_URL,
  });
}

function getModel() {
  return process.env.OPENAI_MODEL ?? 'gpt-4o';
}

/** Strip markdown fences if the model wraps the HTML in ```html ... ``` */
function stripFences(text: string): string {
  let html = text.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return html;
}

// ── One-shot (for Canvas Agent tool) ─────────────────────────────────

export async function generateHTML(prompt: string): Promise<{ ok: boolean; html?: string; error?: string }> {
  try {
    const { text } = await generateText({
      model: getProvider()(getModel()),
      system: SYSTEM_PROMPT,
      prompt,
    });
    return { ok: true, html: stripFences(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ── Streaming (for renderer AI tab) ──────────────────────────────────

/**
 * Stream HTML generation. Calls `onDelta` with each text chunk as it
 * arrives from the model. Returns the full HTML when complete.
 *
 * `onDelta` receives the incremental chunk (NOT the accumulated text).
 * The caller is responsible for concatenation.
 */
export async function streamHTML(
  prompt: string,
  onDelta: (delta: string) => void,
): Promise<{ ok: boolean; html?: string; error?: string }> {
  try {
    const result = streamText({
      model: getProvider()(getModel()),
      system: SYSTEM_PROMPT,
      prompt,
    });

    let accumulated = '';
    for await (const part of result.textStream) {
      accumulated += part;
      onDelta(part);
    }

    return { ok: true, html: stripFences(accumulated) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

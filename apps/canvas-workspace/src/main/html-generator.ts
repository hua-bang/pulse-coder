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

const SYSTEM_PROMPT = `You are an expert HTML/CSS/JS developer. The user will describe a visual or interactive element they want.

Your job:
- Generate a **single, self-contained HTML document** that renders the requested content.
- Include all CSS and JavaScript inline (no external dependencies unless loaded via CDN).
- Use modern HTML5, CSS3, and vanilla JavaScript.
- Make it visually polished — use good typography, spacing, and color.
- If the user asks for charts/diagrams, use SVG or Canvas API (or a CDN library like Chart.js / D3 if needed).
- The HTML will be rendered inside a sandboxed iframe, so it must be fully self-contained.
- Respond with ONLY the raw HTML. No markdown fences, no explanation, no commentary.
- Start your response with <!DOCTYPE html> or <html>.

IMPORTANT — Structure for progressive rendering:
- Put <style> tags in <head> FIRST so styles apply before content appears.
- Put content HTML in <body> NEXT so the layout renders progressively.
- Put <script> tags at the VERY END of <body> so they execute after content is visible.
This order lets the page build up visually: styles → structure → interactivity.`;

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

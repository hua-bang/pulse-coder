/**
 * IPC handlers for HTML generation.
 *
 * Channels:
 *   llm:generate-html         — one-shot, returns { ok, html?, error? }
 *   llm:stream-html           — streaming: returns { ok, requestId } immediately,
 *                                then sends deltas + completion via event channels:
 *     llm:html-delta:{id}     — text chunk (incremental)
 *     llm:html-complete:{id}  — { ok, html?, error? } when done
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { generateHTML, streamHTML } from './html-generator';

export function setupHtmlGeneratorIpc(): void {
  // ── One-shot (kept for Canvas Agent tool usage) ────────────────────
  ipcMain.handle(
    'llm:generate-html',
    async (_event, payload: { prompt: string }) => {
      if (!payload?.prompt?.trim()) {
        return { ok: false, error: 'Prompt is required' };
      }
      return generateHTML(payload.prompt.trim());
    },
  );

  // ── Streaming (used by the renderer AI tab) ────────────────────────
  ipcMain.handle(
    'llm:stream-html',
    (event, payload: { prompt: string }) => {
      if (!payload?.prompt?.trim()) {
        return { ok: false, error: 'Prompt is required' };
      }

      const requestId = randomUUID();
      const sender = event.sender;

      // Fire-and-forget: stream deltas asynchronously
      void (async () => {
        try {
          const result = await streamHTML(
            payload.prompt.trim(),
            (delta) => {
              if (!sender.isDestroyed()) {
                sender.send(`llm:html-delta:${requestId}`, delta);
              }
            },
          );
          if (!sender.isDestroyed()) {
            sender.send(`llm:html-complete:${requestId}`, result);
          }
        } catch (err) {
          if (!sender.isDestroyed()) {
            sender.send(`llm:html-complete:${requestId}`, {
              ok: false,
              error: String(err),
            });
          }
        }
      })();

      return { ok: true, requestId };
    },
  );
}

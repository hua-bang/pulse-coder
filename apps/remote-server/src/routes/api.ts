import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { dispatch } from '../core/dispatcher.js';
import { webAdapter, submitWebClarification } from '../adapters/web/adapter.js';
import { connectWriter, hasSlot } from '../adapters/web/sse-registry.js';
import { sessionStore } from '../core/session-store.js';

export const apiRouter = new Hono();

/**
 * POST /api/chat
 * Submit a message and get back a streamId to open SSE.
 *
 * Body: { userId: string; message: string; forceNew?: boolean }
 * Response: 202 { ok: true, streamId: string }
 */
apiRouter.post('/chat', (c) => dispatch(webAdapter, c));

/**
 * GET /api/stream/:streamId
 * Open an SSE connection to receive events from an agent run.
 *
 * Events: text | tool_call | clarification | done | error
 */
apiRouter.get('/stream/:streamId', (c) => {
  const { streamId } = c.req.param();

  if (!hasSlot(streamId)) {
    return c.json({ error: 'Stream not found' }, 404);
  }

  return streamSSE(c, async (stream) => {
    // Register the SSE writer — flushes any buffered events immediately
    connectWriter(streamId, (event, dataStr) => {
      stream.writeSSE({ event, data: dataStr }).catch(() => {});
    });

    // Keep the connection alive until the client disconnects or stream closes
    await new Promise<void>((resolve) => {
      // Hono's streamSSE will close when the function returns
      // We wait for the client to disconnect (stream abort signal)
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      // Also resolve when stream is done (done/error event sent → slot closed after 30s)
      // We poll to detect closure (simpler than a shared event emitter)
      const pollInterval = setInterval(() => {
        if (!hasSlot(streamId)) {
          clearInterval(pollInterval);
          resolve();
        }
      }, 1000);
    });
  });
});

/**
 * POST /api/clarify/:streamId
 * Submit the user's answer to a pending clarification request.
 *
 * Body: { clarificationId: string; answer: string }
 * Response: { ok: boolean }
 */
apiRouter.post('/clarify/:streamId', async (c) => {
  const { streamId } = c.req.param();
  let body: { clarificationId?: string; answer?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  if (!body.clarificationId || body.answer === undefined) {
    return c.json({ ok: false, error: 'clarificationId and answer are required' }, 400);
  }

  const ok = submitWebClarification(streamId, body.clarificationId, body.answer);
  return c.json({ ok });
});

/**
 * GET /api/sessions
 * List sessions for a given userId (platform-agnostic via platformKey).
 *
 * Query: ?platformKey=web:user-xyz
 */
apiRouter.get('/sessions', async (c) => {
  const platformKey = c.req.query('platformKey');
  if (!platformKey) {
    return c.json({ error: 'platformKey is required' }, 400);
  }

  const sessions = await sessionStore.listSessions(platformKey, 50);
  const currentSessionId = sessionStore.getCurrentSessionId(platformKey) ?? null;

  return c.json({ sessions, currentSessionId });
});


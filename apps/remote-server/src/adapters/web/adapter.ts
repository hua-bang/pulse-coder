import { randomUUID } from 'crypto';
import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { createSlot, pushEvent, closeSlot } from './sse-registry.js';

/**
 * Web adapter: SSE-based streaming.
 *
 * Flow:
 *   POST /api/chat             → 202 { streamId }  (streamId pre-generated in parseIncoming)
 *   GET  /api/stream/:streamId → SSE connection (events buffered if connected late)
 *   POST /api/clarify/:streamId → { clarificationId, answer }
 */
export class WebAdapter implements PlatformAdapter {
  name = 'web';

  verifyRequest(req: HonoRequest): boolean {
    const secret = process.env.WEB_API_SECRET;
    if (!secret) return true; // No auth configured — open access
    const auth = req.header('authorization') ?? '';
    return auth === `Bearer ${secret}`;
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    let body: { userId?: string; message?: string; forceNew?: boolean };
    try {
      body = await req.json();
    } catch {
      return null;
    }

    if (!body.userId || !body.message) return null;

    const platformKey = `web:${body.userId}`;
    const streamId = randomUUID();

    // Reserve an SSE slot now so events are buffered if the client opens SSE slightly late
    createSlot(streamId);

    return {
      platformKey,
      text: body.message,
      forceNewSession: body.forceNew,
      streamId, // Pre-allocated; returned in ackRequest and used by dispatcher
    };
  }

  ackRequest(c: HonoContext, incoming: IncomingMessage | null): Response {
    if (!incoming) return c.json({ ok: true }, 200);
    // Return 202 with the streamId so the client knows where to open SSE
    return c.json({ ok: true, streamId: incoming.streamId }, 202);
  }

  async createStreamHandle(incoming: IncomingMessage, streamId: string): Promise<StreamHandle> {
    function push(event: string, data: unknown) {
      pushEvent(streamId, event, data);
    }

    return {
      async onText(delta) { push('text', { delta }); },
      async onToolCall(name, input) { push('tool_call', { toolName: name, input }); },
      async onToolResult(result) { push('tool_result', { result }); },
      async onClarification(req: ClarificationRequest) { push('clarification', req); },
      async onDone(result) {
        push('done', { result });
        closeSlot(streamId);
      },
      async onError(err) {
        push('error', { message: err.message });
        closeSlot(streamId);
      },
    };
  }
}

export const webAdapter = new WebAdapter();

/** Called by POST /api/clarify/:streamId */
export function submitWebClarification(streamId: string, clarificationId: string, answer: string): boolean {
  return clarificationQueue.submitAnswer(streamId, clarificationId, answer);
}

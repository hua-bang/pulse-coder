import type { Context } from 'pulse-coder-engine';
import type { ClarificationRequest } from 'pulse-coder-engine';
import type { HonoRequest, Context as HonoContext } from 'hono';

export type { Context, ClarificationRequest };

/**
 * Unified message structure parsed from any platform's raw webhook payload.
 */
export interface IncomingMessage {
  /** "feishu:ou_abc123" | "telegram:987654" | "web:user-xyz" */
  platformKey: string;
  /**
   * Optional memory identity key. If omitted, platformKey is used.
   * This lets adapters share long-term memory without merging runtime session/concurrency scopes.
   */
  memoryKey?: string;
  /** The user's text input */
  text: string;
  /** True when the platform payload explicitly requests a fresh session */
  forceNewSession?: boolean;
  /**
   * Pre-allocated streamId — set by adapters that need to return it in ackRequest
   * (e.g. Web adapter returns streamId in 202 response so the client can open SSE).
   * If not set, the dispatcher generates one.
   */
  streamId?: string;
}

/**
 * Streaming output handle returned by each platform adapter.
 * The dispatcher calls these callbacks as the agent runs.
 */
export interface StreamHandle {
  onText(delta: string): Promise<void>;
  onToolCall(name: string, input: unknown): Promise<void>;
  onToolResult?(result: unknown): Promise<void>;
  onClarification(req: ClarificationRequest): Promise<void>;
  onDone(result: string): Promise<void>;
  onError(err: Error): Promise<void>;
}

/**
 * Each platform implements this interface.
 * The dispatcher is fully platform-agnostic — it only calls these lifecycle methods.
 */
export interface PlatformAdapter {
  name: string;

  /**
   * Verify the webhook request signature.
   * Return true to allow, false to reject with 401.
   * Web adapter can always return true (uses its own auth header check).
   */
  verifyRequest(req: HonoRequest): boolean | Promise<boolean>;

  /**
   * Parse the raw platform payload into a unified IncomingMessage.
   * Return null to skip processing (heartbeats, deduped events, clarification answers).
   * Note: clarification answers should be handled here via clarificationQueue.submitAnswer().
   */
  parseIncoming(req: HonoRequest): Promise<IncomingMessage | null>;

  /**
   * Return the HTTP response to send back to the platform immediately.
   * Feishu and Telegram require a fast 200 ack before async processing begins.
   * The incoming param allows adapters to include per-request data (e.g. streamId) in the ack.
   */
  ackRequest(c: HonoContext, incoming: IncomingMessage | null): Response;

  /**
   * Create the streaming output handle for this specific run.
   * Called after session lookup, just before engine.run().
   */
  createStreamHandle(incoming: IncomingMessage, streamId: string): Promise<StreamHandle>;
}

export interface ActiveRun {
  streamId: string;
  ac: AbortController;
  startedAt: number;
}

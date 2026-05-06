import { dispatchIncoming } from '../../core/dispatcher.js';
import type { IncomingMessage, IncomingAttachment } from '../../core/types.js';
import { discordAdapter, DISCORD_CANCEL_REACTION, buildDiscordCancelToken } from './adapter.js';
import { abortAndClearActiveRun, resolvePlatformKeyByCancelToken } from '../../core/active-run-store.js';
import { DiscordClient } from './client.js';
import { getDiscordProxyDispatcher } from './proxy.js';
import { buildDiscordMemoryKey, buildDiscordPlatformKey, isDiscordThreadChannelType } from './platform-key.js';

interface GatewayPayload {
  op: number;
  t?: string;
  s?: number;
  d?: unknown;
}

interface HelloPayload {
  heartbeat_interval?: number;
}

interface ReadyPayload {
  user?: {
    id?: string;
  };
  session_id?: string;
  resume_gateway_url?: string;
}

interface MessageCreatePayload {
  id?: string;
  guild_id?: string;
  channel_id?: string;
  content?: string;
  thread?: {
    id?: string;
  };
  author?: {
    id?: string;
    bot?: boolean;
  };
  mentions?: Array<{
    id?: string;
  }>;
  attachments?: DiscordMessageAttachment[];
}

interface DiscordMessageAttachment {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
}

interface ThreadCreatePayload {
  id?: string;
  type?: number;
  member?: unknown;
}

interface ReactionAddPayload {
  user_id?: string;
  channel_id?: string;
  message_id?: string;
  emoji?: { name?: string | null };
}

export interface DiscordGatewayStatus {
  enabled: boolean;
  configured: boolean;
  shouldMonitor: boolean;
  started: boolean;
  connected: boolean;
  ready: boolean;
  reconnectAttempt: number;
  hasReconnectTimer: boolean;
  heartbeatIntervalMs: number | null;
  ackStaleThresholdMs: number;
  lastStartAt: number | null;
  lastReadyAt: number | null;
  lastDispatchAt: number | null;
  lastAckAt: number | null;
  lastAckAgeMs: number | null;
  healthy: boolean;
  hasSession: boolean;
  sessionAgeMs: number | null;
}

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
// GUILDS(1) + GUILD_MESSAGES(512) + GUILD_MESSAGE_REACTIONS(1024)
// + DIRECT_MESSAGES(4096) + DIRECT_MESSAGE_REACTIONS(8192) + MESSAGE_CONTENT(32768)
const DISCORD_GATEWAY_INTENTS = 1 + 512 + 1024 + 4096 + 8192 + 32768;
const MAX_RECONNECT_DELAY_MS = 30000;
const MIN_CONNECT_INTERVAL_MS = 5500;
const STABLE_CONNECTION_MS = 5 * 60 * 1000;
const DEFAULT_ACK_STALE_THRESHOLD_MS = 90000;
const DISCORD_CHANNEL_DIRECT_REPLY_MEMBER_COUNT = 2;

export class DiscordDmGateway {
  private readonly client = new DiscordClient();
  private readonly gatewayUrl = process.env.DISCORD_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  private readonly botToken = process.env.DISCORD_BOT_TOKEN?.trim() || '';
  private readonly enabled = parseEnabledFlag(process.env.DISCORD_DM_GATEWAY_ENABLED);
  private readonly guildRequireMention = parseEnabledFlag(process.env.DISCORD_GUILD_REQUIRE_MENTION, true);

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isClosing = false;
  private isReconnecting = false;
  private isStopped = false;
  private isStarted = false;
  private reconnectAttempt = 0;
  private sequence: number | null = null;
  private selfUserId: string | null = null;
  private heartbeatIntervalMs: number | null = null;
  private lastStartAt: number | null = null;
  private lastReadyAt: number | null = null;
  private lastDispatchAt: number | null = null;
  private lastAckAt: number | null = null;
  private readonly seenMessageIds = new Set<string>();
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectAt = 0;

  start(): void {
    if (!this.enabled) {
      this.isStarted = false;
      console.log('[discord-gateway] Gateway listener disabled by DISCORD_DM_GATEWAY_ENABLED=false');
      return;
    }

    if (!this.botToken) {
      this.isStarted = false;
      console.log('[discord-gateway] Gateway listener disabled: DISCORD_BOT_TOKEN is not set');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isStopped = false;
    this.isStarted = true;
    this.lastStartAt = Date.now();
    this.lastAckAt = null;
    this.connect();
  }

  stop(): void {
    this.isStopped = true;
    this.isStarted = false;
    this.isClosing = false;
    this.isReconnecting = false;
    this.clearHeartbeat();
    this.clearReconnect();
    this.clearStableTimer();
    this.heartbeatIntervalMs = null;
    this.selfUserId = null;
    this.lastAckAt = null;
    this.invalidateSession();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  getStatus(now = Date.now()): DiscordGatewayStatus {
    const configured = Boolean(this.botToken);
    const shouldMonitor = this.enabled && configured;
    const connected = this.ws?.readyState === WebSocket.OPEN;
    const heartbeatIntervalMs = this.heartbeatIntervalMs;
    const ackStaleThresholdMs = Math.max(DEFAULT_ACK_STALE_THRESHOLD_MS, (heartbeatIntervalMs ?? 0) * 3);
    const lastAckAgeMs = this.lastAckAt ? Math.max(0, now - this.lastAckAt) : null;
    const healthy = !shouldMonitor || (this.isStarted && connected && lastAckAgeMs !== null && lastAckAgeMs <= ackStaleThresholdMs);

    return {
      enabled: this.enabled,
      configured,
      shouldMonitor,
      started: this.isStarted,
      connected,
      ready: this.selfUserId !== null,
      reconnectAttempt: this.reconnectAttempt,
      hasReconnectTimer: this.reconnectTimer !== null,
      heartbeatIntervalMs,
      ackStaleThresholdMs,
      lastStartAt: this.lastStartAt,
      lastReadyAt: this.lastReadyAt,
      lastDispatchAt: this.lastDispatchAt,
      lastAckAt: this.lastAckAt,
      lastAckAgeMs,
      healthy,
      hasSession: this.sessionId !== null,
      sessionAgeMs: this.lastReadyAt ? Math.max(0, now - this.lastReadyAt) : null,
    };
  }

  private connect(): void {
    if (this.isStopped) {
      return;
    }

    this.clearReconnect();

    const now = Date.now();
    const elapsed = now - this.lastConnectAt;
    if (elapsed < MIN_CONNECT_INTERVAL_MS) {
      const wait = MIN_CONNECT_INTERVAL_MS - elapsed;
      console.log(`[discord-gateway] Rate limiting: waiting ${wait}ms before connecting`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectInternal();
      }, wait);
      return;
    }

    this.connectInternal();
  }

  private connectInternal(): void {
    if (this.isStopped) {
      return;
    }

    this.lastConnectAt = Date.now();

    try {
      const url = this.resumeGatewayUrl || this.gatewayUrl;
      const ws = new WebSocket(url, {
        dispatcher: getDiscordProxyDispatcher(),
      });
      this.ws = ws;

      ws.addEventListener('open', () => {
        console.log(`[discord-gateway] Connected to Discord Gateway (resume=${Boolean(this.sessionId)})`);
      });

      ws.addEventListener('message', (event) => {
        this.handleRawMessage(event.data).catch((err) => {
          console.error('[discord-gateway] Failed to handle gateway message:', err);
        });
      });

      ws.addEventListener('close', (event) => {
        this.ws = null;
        this.clearHeartbeat();
        this.clearStableTimer();
        this.heartbeatIntervalMs = null;

        if (this.isStopped) {
          return;
        }

        if (event.code === 4004) {
          console.error('[discord-gateway] Authentication failed (4004). Check DISCORD_BOT_TOKEN and restart the service.');
          this.isStopped = true;
          this.isStarted = false;
          this.clearReconnect();
          this.invalidateSession();
          this.selfUserId = null;
          return;
        }

        if (event.code === 4014) {
          console.error('[discord-gateway] Invalid intents (4014). Check DISCORD_* intent settings and restart the service.');
          this.isStopped = true;
          this.isStarted = false;
          this.clearReconnect();
          this.invalidateSession();
          this.selfUserId = null;
          return;
        }

        if (event.code === 4007 || event.code === 4009) {
          console.warn(`[discord-gateway] Session invalidated by Discord (${event.code}); will IDENTIFY on reconnect`);
          this.invalidateSession();
          this.selfUserId = null;
        }

        console.warn(`[discord-gateway] Gateway closed (${event.code}): ${event.reason || 'no reason'}`);
        this.scheduleReconnect();
      });

      ws.addEventListener('error', (event) => {
        if (this.isClosing || this.isReconnecting) {
          return;
        }
        console.error('[discord-gateway] Gateway socket error:', event);
        this.forceReconnect();
      });
    } catch (err) {
      console.error('[discord-gateway] Failed to connect to Discord Gateway:', err);
      this.scheduleReconnect();
    }
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    const text = await toGatewayPayloadText(raw);
    if (!text) {
      return;
    }

    let payload: GatewayPayload;

    try {
      payload = JSON.parse(text) as GatewayPayload;
    } catch {
      return;
    }

    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 10:
        this.handleHello(payload.d as HelloPayload);
        return;
      case 11:
        this.lastAckAt = Date.now();
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        console.log('[discord-gateway] Reconnect requested by Discord');
        this.forceReconnect();
        return;
      case 9: {
        const resumable = payload.d === true;
        if (resumable) {
          console.warn('[discord-gateway] Invalid session (resumable); will retry RESUME');
        } else {
          console.warn('[discord-gateway] Invalid session (not resumable); clearing session, will IDENTIFY');
          this.invalidateSession();
        }
        this.forceReconnect();
        return;
      }
      case 0:
        this.lastDispatchAt = Date.now();
        await this.handleDispatch(payload.t, payload.d);
        return;
      default:
        return;
    }
  }

  private handleHello(hello: HelloPayload): void {
    const interval = Math.max(1000, hello.heartbeat_interval ?? 41250);
    this.heartbeatIntervalMs = interval;
    this.startHeartbeat(interval);

    if (this.sessionId && this.sequence !== null) {
      this.resume();
    } else {
      this.identify();
    }
  }

  private async handleDispatch(type: string | undefined, data: unknown): Promise<void> {
    if (type === 'READY') {
      const ready = data as ReadyPayload;
      this.selfUserId = ready.user?.id ?? null;
      this.sessionId = ready.session_id ?? null;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.lastReadyAt = Date.now();
      this.scheduleStableReset();
      console.log(`[discord-gateway] READY event received (sessionId=${this.sessionId ?? 'none'})`);
      return;
    }

    if (type === 'RESUMED') {
      this.lastReadyAt = Date.now();
      this.scheduleStableReset();
      console.log('[discord-gateway] RESUMED successfully');
      return;
    }

    if (type === 'THREAD_CREATE') {
      this.handleThreadCreate(data as ThreadCreatePayload);
      return;
    }

    if (type === 'MESSAGE_CREATE') {
      await this.handleMessageCreate(data as MessageCreatePayload);
      return;
    }

    if (type === 'MESSAGE_REACTION_ADD') {
      this.handleReactionAdd(data as ReactionAddPayload);
    }
  }

  private handleReactionAdd(reaction: ReactionAddPayload): void {
    const channelId = reaction.channel_id?.trim();
    const messageId = reaction.message_id?.trim();
    const userId = reaction.user_id?.trim();
    const emoji = reaction.emoji?.name?.trim();

    if (!channelId || !messageId || !emoji) {
      return;
    }

    if (this.selfUserId && userId === this.selfUserId) {
      return;
    }

    if (emoji !== DISCORD_CANCEL_REACTION) {
      return;
    }

    const token = buildDiscordCancelToken(channelId, messageId);
    const platformKey = resolvePlatformKeyByCancelToken(token);
    if (!platformKey) {
      return;
    }

    const result = abortAndClearActiveRun(platformKey);
    if (result.aborted) {
      console.log(`[discord-gateway] Cancelled active run via ❌ reaction platformKey=${platformKey}`);
    }
  }

  private handleThreadCreate(thread: ThreadCreatePayload): void {
    const threadId = thread.id?.trim();
    if (!threadId) {
      return;
    }

    if (typeof thread.type === 'number' && !isDiscordThreadChannelType(thread.type)) {
      return;
    }

    const hasMember = Boolean(thread.member);
    console.log(`[discord-gateway] THREAD_CREATE id=${threadId} hasMember=${hasMember}`);
    if (hasMember) {
      this.client.markThreadJoined(threadId);
      return;
    }

    this.client.ensureThreadMembership(threadId, {
      assumeThread: true,
      source: 'thread_create_event',
      log: true,
    }).catch((err) => {
      console.warn(`[discord-gateway] Failed to join thread ${threadId} on create:`, err);
    });
  }

  private async handleMessageCreate(message: MessageCreatePayload): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const messageId = message.id?.trim();
    const channelId = message.channel_id?.trim();
    const userId = message.author?.id?.trim();
    const rawContent = message.content ?? '';
    const guildId = message.guild_id?.trim();
    const isGuildMessage = Boolean(guildId);
    const threadId = message.thread?.id?.trim();
    const isThread = Boolean(threadId);

    if (!messageId || !channelId || !userId) {
      return;
    }

    if (message.author?.bot) {
      return;
    }

    if (this.selfUserId && userId === this.selfUserId) {
      return;
    }

    if (this.seenMessageIds.has(messageId)) {
      return;
    }
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 1000) {
      this.seenMessageIds.delete(this.seenMessageIds.values().next().value as string);
    }

    const mentionedSelf = isMessageMentioningSelf(message, this.selfUserId);

    const participantCount = await this.client.getChannelParticipantCount(channelId);
    if (participantCount === null) {
      if (!isGuildMessage) {
        console.warn(`[discord-gateway] Skip message because channel participant count is unavailable channel=${channelId}`);
        return;
      }
    } else {
      if (participantCount < DISCORD_CHANNEL_DIRECT_REPLY_MEMBER_COUNT) {
        return;
      }
      if (participantCount > DISCORD_CHANNEL_DIRECT_REPLY_MEMBER_COUNT && !mentionedSelf) {
        return;
      }
    }

    let resolvedIsThread = isThread;
    if (!resolvedIsThread && isGuildMessage) {
      const channelType = await this.client.getChannelType(channelId);
      resolvedIsThread = isDiscordThreadChannelType(channelType);
    }

    if (resolvedIsThread) {
      await this.client.ensureThreadMembership(channelId, {
        source: 'message_create',
        log: true,
      });
    }

    const platformKey = buildDiscordPlatformKey({
      guildId,
      channelId,
      userId,
      isThread: resolvedIsThread,
    });
    const memoryKey = buildDiscordMemoryKey(userId);

    const clarificationText = normalizeGatewayText(stripSelfMention(rawContent, this.selfUserId));
    if (clarificationText) {
      const consumedClarification = await discordAdapter.tryHandleChannelClarification(
        platformKey,
        channelId,
        clarificationText,
        resolvedIsThread,
      );
      if (consumedClarification) {
        return;
      }
    }

    if (isGuildMessage && !resolvedIsThread && this.guildRequireMention && !mentionedSelf) {
      return;
    }

    const textSource = isGuildMessage ? stripSelfMention(rawContent, this.selfUserId) : rawContent;
    const normalizedText = normalizeGatewayText(textSource);
    const attachments = extractIncomingAttachments(message.attachments, messageId);

    if (!normalizedText && attachments.length === 0) {
      return;
    }

    await this.client.triggerTypingIndicator(channelId, { assumeThread: resolvedIsThread }).catch((err) => {
      console.error('[discord-gateway] Failed to send typing indicator:', err);
    });

    const replyToMessageId = messageId;

    const incoming: IncomingMessage = {
      platformKey,
      memoryKey,
      text: normalizedText,
      attachments: attachments.length > 0 ? attachments : undefined,
      streamId: messageId,
    };

    discordAdapter.registerChannelStreamMeta(platformKey, messageId, channelId, resolvedIsThread, replyToMessageId);
    dispatchIncoming(discordAdapter, incoming);
  }

  private identify(): void {
    console.log('[discord-gateway] Sending IDENTIFY');
    this.send({
      op: 2,
      d: {
        token: this.botToken,
        intents: DISCORD_GATEWAY_INTENTS,
        properties: {
          os: process.platform,
          browser: 'pulse-remote-server',
          device: 'pulse-remote-server',
        },
      },
    });
  }

  private resume(): void {
    console.log(`[discord-gateway] Sending RESUME (sessionId=${this.sessionId}, seq=${this.sequence})`);
    this.send({
      op: 6,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();

    const jitterDelay = Math.floor(Math.random() * intervalMs);
    setTimeout(() => {
      if (!this.ws || this.isStopped) {
        return;
      }
      this.sendHeartbeat();
    }, jitterDelay);

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.send({
      op: 1,
      d: this.sequence,
    });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.isStopped || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));

    this.isReconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      this.connect();
    }, delay);

    console.log(`[discord-gateway] Reconnecting in ${delay}ms`);
  }

  private forceReconnect(): void {
    if (this.isStopped || this.isReconnecting) {
      return;
    }

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.isClosing = true;
      try {
        ws.close();
      } finally {
        this.isClosing = false;
      }
    }

    this.clearHeartbeat();
    this.scheduleReconnect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private invalidateSession(): void {
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.sequence = null;
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (!this.isStopped && this.ws?.readyState === WebSocket.OPEN) {
        this.reconnectAttempt = 0;
        console.log('[discord-gateway] Connection stable; reset reconnect backoff');
      }
    }, STABLE_CONNECTION_MS);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
}

function parseEnabledFlag(raw: string | undefined, defaultValue = true): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }

  return true;
}

async function toGatewayPayloadText(raw: unknown): Promise<string | null> {
  if (typeof raw === 'string') {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }

  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }

  if (raw instanceof Blob) {
    return await raw.text();
  }

  return null;
}

function extractIncomingAttachments(
  attachments: DiscordMessageAttachment[] | undefined,
  messageId?: string,
): IncomingAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: IncomingAttachment[] = [];
  for (const attachment of attachments) {
    const url = attachment.url?.trim() || attachment.proxy_url?.trim();
    if (!url) {
      continue;
    }

    results.push({
      id: attachment.id,
      url,
      name: attachment.filename?.trim() || undefined,
      mimeType: attachment.content_type?.trim() || undefined,
      size: typeof attachment.size === 'number' ? attachment.size : undefined,
      source: 'discord',
      messageId,
    });
  }

  return results;
}

function normalizeGatewayText(text: string): string {
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();

  if (lowered === '/ask' || lowered === '/chat' || lowered === '/prompt') {
    return '';
  }

  if (lowered.startsWith('/ask ')) {
    return trimmed.slice(5).trim();
  }

  if (lowered.startsWith('/chat ')) {
    return trimmed.slice(6).trim();
  }

  if (lowered.startsWith('/prompt ')) {
    return trimmed.slice(8).trim();
  }

  return trimmed;
}

function isMessageMentioningSelf(message: MessageCreatePayload, selfUserId: string | null): boolean {
  if (!selfUserId) {
    return false;
  }

  if (message.mentions?.some((mention) => mention.id?.trim() === selfUserId)) {
    return true;
  }

  const content = message.content ?? '';
  return content.includes(`<@${selfUserId}>`) || content.includes(`<@!${selfUserId}>`);
}

function stripSelfMention(text: string, selfUserId: string | null): string {
  const trimmed = text.trim();
  if (!trimmed || !selfUserId) {
    return trimmed;
  }

  const escapedId = escapeRegExp(selfUserId);
  return trimmed.replace(new RegExp(`<@!?${escapedId}>`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import { dispatchIncoming } from '../../core/dispatcher.js';
import type { IncomingMessage } from '../../core/types.js';
import { discordAdapter } from './adapter.js';
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
}

interface ThreadCreatePayload {
  id?: string;
  type?: number;
  member?: unknown;
}

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_GATEWAY_INTENTS = 1 + 512 + 4096 + 32768;
const MAX_RECONNECT_DELAY_MS = 30000;

export class DiscordDmGateway {
  private readonly client = new DiscordClient();
  private readonly gatewayUrl = process.env.DISCORD_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  private readonly botToken = process.env.DISCORD_BOT_TOKEN?.trim() || '';
  private readonly enabled = parseEnabledFlag(process.env.DISCORD_DM_GATEWAY_ENABLED);
  private readonly guildRequireMention = parseEnabledFlag(process.env.DISCORD_GUILD_REQUIRE_MENTION, true);

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isStopped = false;
  private reconnectAttempt = 0;
  private sequence: number | null = null;
  private selfUserId: string | null = null;
  private readonly seenMessageIds = new Set<string>();

  start(): void {
    if (!this.enabled) {
      console.log('[discord-gateway] Gateway listener disabled by DISCORD_DM_GATEWAY_ENABLED=false');
      return;
    }

    if (!this.botToken) {
      console.log('[discord-gateway] Gateway listener disabled: DISCORD_BOT_TOKEN is not set');
      return;
    }

    this.isStopped = false;
    this.connect();
  }

  stop(): void {
    this.isStopped = true;
    this.clearHeartbeat();
    this.clearReconnect();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.isStopped) {
      return;
    }

    this.clearReconnect();

    try {
      const ws = new WebSocket(this.gatewayUrl, {
        dispatcher: getDiscordProxyDispatcher(),
      });
      this.ws = ws;

      ws.addEventListener('open', () => {
        console.log('[discord-gateway] Connected to Discord Gateway');
      });

      ws.addEventListener('message', (event) => {
        this.handleRawMessage(event.data).catch((err) => {
          console.error('[discord-gateway] Failed to handle gateway message:', err);
        });
      });

      ws.addEventListener('close', (event) => {
        this.ws = null;
        this.clearHeartbeat();

        if (this.isStopped) {
          return;
        }

        console.warn(`[discord-gateway] Gateway closed (${event.code}): ${event.reason || 'no reason'}`);
        this.scheduleReconnect();
      });

      ws.addEventListener('error', (event) => {
        console.error('[discord-gateway] Gateway socket error:', event);
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
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        console.log('[discord-gateway] Reconnect requested by Discord');
        this.forceReconnect();
        return;
      case 9:
        console.warn('[discord-gateway] Invalid session; reconnecting');
        this.forceReconnect();
        return;
      case 0:
        await this.handleDispatch(payload.t, payload.d);
        return;
      default:
        return;
    }
  }

  private handleHello(hello: HelloPayload): void {
    const interval = Math.max(1000, hello.heartbeat_interval ?? 41250);
    this.startHeartbeat(interval);
    this.identify();
  }

  private async handleDispatch(type: string | undefined, data: unknown): Promise<void> {
    if (type === 'READY') {
      const ready = data as ReadyPayload;
      this.selfUserId = ready.user?.id ?? null;
      this.reconnectAttempt = 0;
      console.log('[discord-gateway] READY event received');
      return;
    }

    if (type === 'THREAD_CREATE') {
      this.handleThreadCreate(data as ThreadCreatePayload);
      return;
    }

    if (type === 'MESSAGE_CREATE') {
      await this.handleMessageCreate(data as MessageCreatePayload);
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
    const isGuildMessage = Boolean(message.guild_id);
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
      guildId: message.guild_id,
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

    const mentionedSelf = isMessageMentioningSelf(message, this.selfUserId);
    if (isGuildMessage && !resolvedIsThread && this.guildRequireMention && !mentionedSelf) {
      return;
    }

    const textSource = isGuildMessage ? stripSelfMention(rawContent, this.selfUserId) : rawContent;
    const normalizedText = normalizeGatewayText(textSource);
    if (!normalizedText) {
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
      streamId: messageId,
    };

    discordAdapter.registerChannelStreamMeta(platformKey, messageId, channelId, resolvedIsThread, replyToMessageId);
    dispatchIncoming(discordAdapter, incoming);
  }


  private identify(): void {
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

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    console.log(`[discord-gateway] Reconnecting in ${delay}ms`);
  }

  private forceReconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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

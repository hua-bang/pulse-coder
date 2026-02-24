import { dispatchIncoming } from '../../core/dispatcher.js';
import type { IncomingMessage } from '../../core/types.js';
import { discordAdapter } from './adapter.js';
import { DiscordClient } from './client.js';
import { getDiscordProxyDispatcher } from './proxy.js';

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
  author?: {
    id?: string;
    bot?: boolean;
  };
}

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_DM_INTENTS = 4096 + 32768;
const MAX_RECONNECT_DELAY_MS = 30000;

export class DiscordDmGateway {
  private readonly client = new DiscordClient();
  private readonly gatewayUrl = process.env.DISCORD_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  private readonly botToken = process.env.DISCORD_BOT_TOKEN?.trim() || '';
  private readonly enabled = parseEnabledFlag(process.env.DISCORD_DM_GATEWAY_ENABLED);

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
      console.log('[discord-gateway] DM gateway disabled by DISCORD_DM_GATEWAY_ENABLED=false');
      return;
    }

    if (!this.botToken) {
      console.log('[discord-gateway] DM gateway disabled: DISCORD_BOT_TOKEN is not set');
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

    if (type === 'MESSAGE_CREATE') {
      await this.handleMessageCreate(data as MessageCreatePayload);
    }
  }

  private async handleMessageCreate(message: MessageCreatePayload): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.guild_id) {
      return;
    }

    const messageId = message.id?.trim();
    const channelId = message.channel_id?.trim();
    const userId = message.author?.id?.trim();
    const content = message.content?.trim() ?? '';

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

    const platformKey = `discord:${userId}`;
    const normalizedText = normalizeDmText(content);

    if (!normalizedText) {
      return;
    }

    const consumedClarification = await discordAdapter.tryHandleDmClarification(platformKey, channelId, normalizedText);
    if (consumedClarification) {
      return;
    }

    await this.client.triggerTypingIndicator(channelId).catch((err) => {
      console.error('[discord-gateway] Failed to send typing indicator:', err);
    });

    const incoming: IncomingMessage = {
      platformKey,
      text: normalizedText,
      streamId: messageId,
    };

    discordAdapter.registerDmStreamMeta(platformKey, messageId, channelId);
    dispatchIncoming(discordAdapter, incoming);
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.botToken,
        intents: DISCORD_DM_INTENTS,
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

function parseEnabledFlag(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return true;
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

function normalizeDmText(text: string): string {
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

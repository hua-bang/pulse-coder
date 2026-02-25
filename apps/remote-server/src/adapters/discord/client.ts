import { readFile } from 'fs/promises';
import { getDiscordProxyDispatcher } from './proxy.js';
import { isDiscordThreadChannelType } from './platform-key.js';

const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_MESSAGE_LIMIT = 2000;
const CHANNEL_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

interface DiscordApiError {
  message?: string;
}

interface DiscordApiEnvelope<T> {
  data?: T;
  errors?: DiscordApiError;
}

interface DiscordMessageResponse {
  id: string;
}

interface DiscordChannelResponse {
  id: string;
  type?: number;
}

interface ChannelTypeCacheEntry {
  type: number | null;
  expiresAt: number;
}

interface EnsureThreadMembershipOptions {
  assumeThread?: boolean;
  source?: string;
  log?: boolean;
}

interface DiscordSendChannelOptions {
  isThread?: boolean;
}

interface RequestRetryOptions {
  isThread: boolean;
  operation: string;
}

export class DiscordClient {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly channelTypeCache = new Map<string, ChannelTypeCacheEntry>();
  private readonly joinedThreadIds = new Set<string>();

  constructor(
    baseUrl = process.env.DISCORD_API_BASE_URL?.trim() || DEFAULT_DISCORD_API_BASE_URL,
    botToken = process.env.DISCORD_BOT_TOKEN?.trim() || '',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.botToken = botToken;
  }

  async editOriginalResponse(applicationId: string, interactionToken: string, content: string): Promise<void> {
    await this.request<void>(`/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: limitDiscordContent(content) }),
    });
  }

  async createFollowupMessage(applicationId: string, interactionToken: string, content: string): Promise<void> {
    await this.request<void>(`/webhooks/${applicationId}/${interactionToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: limitDiscordContent(content) }),
    });
  }

  async createFollowupFile(
    applicationId: string,
    interactionToken: string,
    filePath: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    content?: string,
  ): Promise<void> {
    const fileBuffer = await readFile(filePath);
    const payload = {
      content: content ? limitDiscordContent(content) : undefined,
      attachments: [{ id: 0, filename: fileName }],
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(payload));
    formData.append('files[0]', new Blob([fileBuffer], { type: mimeType }), fileName);

    await this.request<void>(`/webhooks/${applicationId}/${interactionToken}`, {
      method: 'POST',
      body: formData,
    });
  }

  async ensureThreadMembership(channelId: string, options: EnsureThreadMembershipOptions = {}): Promise<boolean> {
    const assumeThread = options.assumeThread === true;
    const source = options.source?.trim() || 'unknown';
    const shouldLog = options.log === true;
    const channelType = assumeThread ? null : await this.getChannelType(channelId);

    if (!assumeThread && (channelType === null || !isDiscordThreadChannelType(channelType))) {
      if (shouldLog) {
        console.log(`[discord] Thread membership skipped for ${channelId} source=${source} reason=not_thread type=${String(channelType)}`);
      }
      return false;
    }

    if (this.joinedThreadIds.has(channelId)) {
      if (shouldLog) {
        console.log(`[discord] Thread membership already known for ${channelId} source=${source}`);
      }
      return true;
    }

    try {
      await this.joinThread(channelId);
      this.joinedThreadIds.add(channelId);
      if (shouldLog) {
        console.log(`[discord] Joined thread ${channelId} source=${source} assumeThread=${assumeThread}`);
      }
      return true;
    } catch (err) {
      console.warn(
        `[discord] Failed to join thread ${channelId} source=${source} assumeThread=${assumeThread} err=${describeDiscordError(err)}`,
      );
      return false;
    }
  }

  markThreadMembership(channelId: string, source = 'unknown'): void {
    this.joinedThreadIds.add(channelId);
    console.log(`[discord] Thread membership marked for ${channelId} source=${source}`);
  }

  async getChannelType(channelId: string): Promise<number | null> {
    if (!this.botToken) {
      return null;
    }

    const cached = this.channelTypeCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.type;
    }

    try {
      const channel = await this.getChannel(channelId);
      const type = typeof channel.type === 'number' ? channel.type : null;
      this.channelTypeCache.set(channelId, {
        type,
        expiresAt: Date.now() + CHANNEL_TYPE_CACHE_TTL_MS,
      });
      return type;
    } catch (err) {
      console.warn(`[discord] Failed to fetch channel metadata for ${channelId}:`, err);
      return null;
    }
  }

  async getChannel(channelId: string): Promise<DiscordChannelResponse> {
    this.ensureBotToken();

    return this.request<DiscordChannelResponse>(
      `/channels/${encodeURIComponent(channelId)}`,
      {
        method: 'GET',
      },
      true,
    );
  }

  async joinThread(channelId: string): Promise<void> {
    this.ensureBotToken();

    await this.request<void>(
      `/channels/${encodeURIComponent(channelId)}/thread-members/@me`,
      {
        method: 'PUT',
      },
      true,
    );
  }

  async sendChannelMessage(
    channelId: string,
    content: string,
    options: DiscordSendChannelOptions = {},
  ): Promise<DiscordMessageResponse> {
    this.ensureBotToken();
    const isThread = options.isThread === true;
    if (isThread) {
      await this.ensureThreadMembership(channelId, { source: 'send_message', log: true });
    }

    return this.requestWithRetry<DiscordMessageResponse>(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: limitDiscordContent(content) }),
      },
      true,
      {
        isThread,
        operation: `send channel message channel=${channelId}`,
      },
    );
  }

  async triggerTypingIndicator(channelId: string, options: DiscordSendChannelOptions = {}): Promise<void> {
    this.ensureBotToken();
    const isThread = options.isThread === true;
    if (isThread) {
      await this.ensureThreadMembership(channelId, { source: 'typing', log: true });
    }

    await this.requestWithRetry<void>(
      `/channels/${encodeURIComponent(channelId)}/typing`,
      {
        method: 'POST',
      },
      true,
      {
        isThread,
        operation: `send typing indicator channel=${channelId}`,
      },
    );
  }

  async editChannelMessage(
    channelId: string,
    messageId: string,
    content: string,
    options: DiscordSendChannelOptions = {},
  ): Promise<void> {
    this.ensureBotToken();
    const isThread = options.isThread === true;
    if (isThread) {
      await this.ensureThreadMembership(channelId, { source: 'edit_message', log: true });
    }

    await this.requestWithRetry<void>(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: limitDiscordContent(content) }),
      },
      true,
      {
        isThread,
        operation: `edit channel message channel=${channelId} message=${messageId}`,
      },
    );
  }

  async sendChannelFile(
    channelId: string,
    filePath: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    content?: string,
    options: DiscordSendChannelOptions = {},
  ): Promise<void> {
    this.ensureBotToken();
    const isThread = options.isThread === true;
    if (isThread) {
      await this.ensureThreadMembership(channelId, { source: 'send_file', log: true });
    }

    const fileBuffer = await readFile(filePath);
    const payload = {
      content: content ? limitDiscordContent(content) : undefined,
      attachments: [{ id: 0, filename: fileName }],
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(payload));
    formData.append('files[0]', new Blob([fileBuffer], { type: mimeType }), fileName);

    await this.requestWithRetry<void>(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        body: formData,
      },
      true,
      {
        isThread,
        operation: `send channel file channel=${channelId} file=${fileName}`,
      },
    );
  }

  private async requestWithRetry<T>(
    path: string,
    init: RequestInit,
    useBotAuthorization: boolean,
    options: RequestRetryOptions,
  ): Promise<T> {
    try {
      return await this.request<T>(path, init, useBotAuthorization);
    } catch (err) {
      if (!options.isThread || !isDiscordTransientNetworkError(err)) {
        throw err;
      }

      const channelMatch = path.match(/^\/channels\/([^/]+)/);
      const channelId = channelMatch ? decodeURIComponent(channelMatch[1]) : '';

      console.warn(
        `[discord] Retrying thread request after transient error op=${options.operation} err=${describeDiscordError(err)}`,
      );

      if (channelId) {
        await this.ensureThreadMembership(channelId, {
          assumeThread: true,
          source: `retry:${options.operation}`,
          log: true,
        });
      }

      await wait(350);
      return this.request<T>(path, init, useBotAuthorization);
    }
  }

  private async request<T>(path: string, init: RequestInit, useBotAuthorization = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (useBotAuthorization) {
      this.ensureBotToken();
      headers.set('authorization', `Bot ${this.botToken}`);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      dispatcher: getDiscordProxyDispatcher(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord API request failed (${response.status} ${response.statusText}): ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    const payload = JSON.parse(text) as DiscordApiEnvelope<T>;

    if (payload.errors?.message) {
      throw new Error(`Discord API error: ${payload.errors.message}`);
    }

    return (payload.data as T) ?? (payload as unknown as T);
  }

  private ensureBotToken(): void {
    if (!this.botToken) {
      throw new Error('DISCORD_BOT_TOKEN is required for Discord DM mode');
    }
  }
}

function limitDiscordContent(text: string): string {
  const normalized = (text || '').trim() || 'Working on it...';
  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDiscordTransientNetworkError(err: unknown): boolean {
  const text = describeDiscordError(err).toLowerCase();
  return text.includes('econnreset')
    || text.includes('connect timeout')
    || text.includes('und_err_connect_timeout')
    || text.includes('fetch failed')
    || text.includes('socket disconnected');
}

function describeDiscordError(err: unknown): string {
  if (!err) {
    return 'unknown';
  }

  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string; cause?: unknown };
    const code = typeof anyErr.code === 'string' ? anyErr.code : '';
    const causeCode = extractCauseCode(anyErr.cause);
    return [code, causeCode, anyErr.message].filter(Boolean).join(' ').trim() || anyErr.name;
  }

  if (typeof err === 'string') {
    return err;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function extractCauseCode(cause: unknown): string {
  if (!cause || typeof cause !== 'object') {
    return '';
  }

  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

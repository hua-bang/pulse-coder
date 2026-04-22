import { readFile } from 'fs/promises';
import { getDiscordProxyDispatcher } from './proxy.js';
import { isDiscordThreadChannelType } from './platform-key.js';

const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DEFAULT_DISCORD_USER_AGENT = 'PulseAgentBot (https://github.com/agent-teams, 1.0)';
const DISCORD_MESSAGE_LIMIT = 2000;
const CHANNEL_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;
const CHANNEL_PARTICIPANT_COUNT_CACHE_TTL_MS = 30 * 1000;
const TRANSIENT_RETRY_DELAY_MS = 350;

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

interface DiscordChannelRecipient {
  id?: string;
}

interface DiscordChannelResponse {
  id: string;
  type?: number;
  member_count?: number;
  recipients?: DiscordChannelRecipient[];
}

interface ChannelTypeCacheEntry {
  type: number | null;
  expiresAt: number;
}

interface ChannelParticipantCountCacheEntry {
  count: number | null;
  expiresAt: number;
}

interface EnsureThreadMembershipOptions {
  assumeThread?: boolean;
  source?: string;
  log?: boolean;
}

export type DiscordButtonStyle = 1 | 2 | 3 | 4 | 5;

export interface DiscordButtonComponent {
  type: 2;
  style: DiscordButtonStyle;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface DiscordMessageComponent {
  type: 1;
  components: DiscordButtonComponent[];
}

interface ChannelRequestOptions {
  assumeThread?: boolean;
  replyToMessageId?: string;
  components?: DiscordMessageComponent[];
}

type DiscordApplicationCommandOptionType = 3;

export interface DiscordApplicationCommandOption {
  type: DiscordApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  max_length?: number;
}

export interface DiscordApplicationCommandCreate {
  name: string;
  description: string;
  options?: DiscordApplicationCommandOption[];
}

interface DiscordApplicationInfo {
  id: string;
}

export class DiscordClient {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly userAgent: string;
  private readonly channelTypeCache = new Map<string, ChannelTypeCacheEntry>();
  private readonly channelParticipantCountCache = new Map<string, ChannelParticipantCountCacheEntry>();
  private readonly joinedThreadIds = new Set<string>();

  constructor(
    baseUrl = process.env.DISCORD_API_BASE_URL?.trim() || DEFAULT_DISCORD_API_BASE_URL,
    botToken = process.env.DISCORD_BOT_TOKEN?.trim() || '',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.botToken = botToken;
    this.userAgent = resolveDiscordUserAgent();
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

  async createFollowupMessageWithComponents(
    applicationId: string,
    interactionToken: string,
    content: string,
    components: DiscordMessageComponent[],
  ): Promise<void> {
    await this.request<void>(`/webhooks/${applicationId}/${interactionToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: limitDiscordContent(content), components }),
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

  async ensureThreadMembership(channelId: string, options: EnsureThreadMembershipOptions = {}): Promise<void> {
    const assumeThread = options.assumeThread === true;
    const source = options.source?.trim() || 'unknown';
    const shouldLog = options.log === true;
    const channelType = assumeThread ? null : await this.getChannelType(channelId);
    const isThread = assumeThread || (channelType !== null && isDiscordThreadChannelType(channelType));

    if (shouldLog) {
      console.log(
        `[discord] ensureThreadMembership channel=${channelId} source=${source} assumeThread=${assumeThread} isThread=${isThread}`,
      );
    }

    if (!isThread) {
      return;
    }

    if (this.joinedThreadIds.has(channelId)) {
      if (shouldLog) {
        console.log(`[discord] Thread already joined channel=${channelId} source=${source}`);
      }
      return;
    }

    try {
      await this.retryOnceOnTransient('join_thread', () => this.joinThread(channelId));
      this.joinedThreadIds.add(channelId);
      if (shouldLog) {
        console.log(`[discord] Joined thread channel=${channelId} source=${source}`);
      }
    } catch (err) {
      console.warn(
        `[discord] Failed to join thread ${channelId} source=${source} assumeThread=${assumeThread} err=${this.describeError(err)}`,
      );
    }
  }

  markThreadJoined(channelId: string): void {
    if (!channelId) {
      return;
    }

    this.joinedThreadIds.add(channelId);
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
      const channel = await this.retryOnceOnTransient('get_channel_type', () => this.getChannel(channelId));
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

  async getChannelParticipantCount(channelId: string): Promise<number | null> {
    if (!this.botToken) {
      return null;
    }

    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      return null;
    }

    const cached = this.channelParticipantCountCache.get(normalizedChannelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.count;
    }

    try {
      const channel = await this.retryOnceOnTransient('get_channel_participant_count', () => this.getChannel(normalizedChannelId));
      const count = deriveChannelParticipantCount(channel);

      this.channelParticipantCountCache.set(normalizedChannelId, {
        count,
        expiresAt: Date.now() + CHANNEL_PARTICIPANT_COUNT_CACHE_TTL_MS,
      });

      return count;
    } catch (err) {
      console.warn(`[discord] Failed to fetch channel participant count for ${normalizedChannelId}:`, err);
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

  async getApplicationId(): Promise<string> {
    this.ensureBotToken();
    const app = await this.request<DiscordApplicationInfo>(
      '/oauth2/applications/@me',
      {
        method: 'GET',
      },
      true,
    );

    const applicationId = app.id?.trim();
    if (!applicationId) {
      throw new Error('Discord application id is missing from /oauth2/applications/@me response');
    }

    return applicationId;
  }

  async upsertGlobalApplicationCommand(
    applicationId: string,
    command: DiscordApplicationCommandCreate,
  ): Promise<void> {
    this.ensureBotToken();
    await this.request<void>(
      `/applications/${encodeURIComponent(applicationId)}/commands`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      },
      true,
    );
  }

  async upsertGuildApplicationCommand(
    applicationId: string,
    guildId: string,
    command: DiscordApplicationCommandCreate,
  ): Promise<void> {
    this.ensureBotToken();
    await this.request<void>(
      `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      },
      true,
    );
  }

  async sendChannelMessage(
    channelId: string,
    content: string,
    options: ChannelRequestOptions = {},
  ): Promise<DiscordMessageResponse> {
    this.ensureBotToken();
    await this.ensureThreadMembership(channelId, {
      assumeThread: options.assumeThread,
      source: 'send_channel_message',
    });

    return this.retryOnceOnTransient('send_channel_message', () =>
      this.request<DiscordMessageResponse>(
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildChannelMessagePayload(content, options.replyToMessageId, options.components)),
        },
        true,
      ),
    );
  }

  async triggerTypingIndicator(channelId: string, options: ChannelRequestOptions = {}): Promise<void> {
    this.ensureBotToken();
    await this.ensureThreadMembership(channelId, {
      assumeThread: options.assumeThread,
      source: 'trigger_typing',
    });

    await this.retryOnceOnTransient('trigger_typing', () =>
      this.request<void>(
        `/channels/${encodeURIComponent(channelId)}/typing`,
        {
          method: 'POST',
        },
        true,
      ),
    );
  }

  async editChannelMessage(
    channelId: string,
    messageId: string,
    content: string,
    options: ChannelRequestOptions = {},
  ): Promise<void> {
    this.ensureBotToken();
    await this.ensureThreadMembership(channelId, {
      assumeThread: options.assumeThread,
      source: 'edit_channel_message',
    });

    await this.retryOnceOnTransient('edit_channel_message', () =>
      this.request<void>(
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildChannelMessageUpdatePayload(content, options.components)),
        },
        true,
      ),
    );
  }

  async sendChannelFile(
    channelId: string,
    filePath: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    content?: string,
    options: ChannelRequestOptions = {},
  ): Promise<void> {
    this.ensureBotToken();
    await this.ensureThreadMembership(channelId, {
      assumeThread: options.assumeThread,
      source: 'send_channel_file',
    });

    const fileBuffer = await readFile(filePath);

    await this.retryOnceOnTransient('send_channel_file', async () => {
      const payload = {
        content: content ? limitDiscordContent(content) : undefined,
        attachments: [{ id: 0, filename: fileName }],
      };

      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      formData.append('files[0]', new Blob([fileBuffer], { type: mimeType }), fileName);

      await this.request<void>(
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          body: formData,
        },
        true,
      );
    });
  }

  private async request<T>(path: string, init: RequestInit, useBotAuthorization = false, attempt = 0): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    if (!headers.has('user-agent')) {
      headers.set('user-agent', this.userAgent);
    }
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
      const contentType = response.headers.get('content-type');
      if (response.status === 429 && attempt < 1) {
        const retryAfterMs = getRetryAfterMs(response, body);
        if (retryAfterMs !== null) {
          await wait(retryAfterMs);
          return this.request(path, init, useBotAuthorization, attempt + 1);
        }
      }
      const formattedBody = formatDiscordErrorBody(body, contentType);
      throw new Error(`Discord API request failed (${response.status} ${response.statusText}): ${formattedBody}`);
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

  private async retryOnceOnTransient<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!this.isTransientNetworkError(err)) {
        throw err;
      }

      console.warn(`[discord] Retrying transient request op=${operation} err=${this.describeError(err)}`);
      await wait(TRANSIENT_RETRY_DELAY_MS);
      return run();
    }
  }

  private isTransientNetworkError(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }

    const code = this.getErrorCode(err);
    if (
      code === 'ECONNRESET'
      || code === 'ETIMEDOUT'
      || code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'UND_ERR_SOCKET'
    ) {
      return true;
    }

    const message = err.message.toLowerCase();
    return (
      message.includes('fetch failed')
      || message.includes('timeout')
      || message.includes('network')
      || message.includes('socket')
      || message.includes('discord api request failed (502')
      || message.includes('discord api request failed (503')
      || message.includes('discord api request failed (504')
    );
  }

  private describeError(err: unknown): string {
    if (!(err instanceof Error)) {
      return String(err);
    }

    const code = this.getErrorCode(err);
    return code ? `${code} ${err.message}` : err.message;
  }

  private getErrorCode(err: Error): string {
    const directCode = (err as Error & { code?: unknown }).code;
    if (typeof directCode === 'string') {
      return directCode;
    }

    const cause = (err as Error & { cause?: { code?: unknown } }).cause;
    if (typeof cause?.code === 'string') {
      return cause.code;
    }

    return '';
  }

  private ensureBotToken(): void {
    if (!this.botToken) {
      throw new Error('DISCORD_BOT_TOKEN is required for Discord DM mode');
    }
  }
}

function deriveChannelParticipantCount(channel: DiscordChannelResponse): number | null {
  const channelType = channel.type;
  if (typeof channelType !== 'number') {
    return null;
  }

  // DM is always user + bot.
  if (channelType === 1) {
    return 2;
  }

  // Group DM recipients do not include the bot account itself.
  if (channelType === 3) {
    return (channel.recipients?.length ?? 0) + 1;
  }

  if (isDiscordThreadChannelType(channelType)) {
    return typeof channel.member_count === 'number' ? channel.member_count : null;
  }

  // Discord does not expose exact participant count for regular guild text channels.
  return null;
}

function limitDiscordContent(text: string): string {
  const normalized = (text || '').trim() || 'Working on it...';
  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...`;
}

function buildChannelMessagePayload(
  content: string,
  replyToMessageId?: string,
  components?: DiscordMessageComponent[],
): {
  content: string;
  message_reference?: { message_id: string; fail_if_not_exists: boolean };
  components?: DiscordMessageComponent[];
} {
  const payload: {
    content: string;
    message_reference?: { message_id: string; fail_if_not_exists: boolean };
    components?: DiscordMessageComponent[];
  } = {
    content: limitDiscordContent(content),
  };

  const trimmedReplyId = replyToMessageId?.trim();
  if (trimmedReplyId) {
    payload.message_reference = {
      message_id: trimmedReplyId,
      fail_if_not_exists: false,
    };
  }

  if (components && components.length > 0) {
    payload.components = components;
  }

  return payload;
}

function buildChannelMessageUpdatePayload(
  content: string,
  components?: DiscordMessageComponent[],
): {
  content: string;
  components?: DiscordMessageComponent[];
} {
  const payload: {
    content: string;
    components?: DiscordMessageComponent[];
  } = {
    content: limitDiscordContent(content),
  };

  if (components !== undefined) {
    payload.components = components;
  }

  return payload;
}

function resolveDiscordUserAgent(): string {
  const fromEnv = process.env.DISCORD_USER_AGENT?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  return DEFAULT_DISCORD_USER_AGENT;
}

function getRetryAfterMs(response: Response, body: string): number | null {
  const headerValue = response.headers.get('retry-after');
  if (headerValue) {
    const headerSeconds = Number.parseFloat(headerValue);
    if (!Number.isNaN(headerSeconds)) {
      return Math.max(0, Math.ceil(headerSeconds * 1000));
    }
  }

  try {
    const parsed = JSON.parse(body) as { retry_after?: number };
    if (typeof parsed.retry_after === 'number') {
      return Math.max(0, Math.ceil(parsed.retry_after * 1000));
    }
  } catch {
    // Ignore JSON parsing errors for non-JSON bodies.
  }

  return null;
}

function formatDiscordErrorBody(body: string, contentType: string | null): string {
  if (!body) {
    return '(empty response body)';
  }

  if (contentType && contentType.includes('text/html')) {
    return 'HTML error page (possibly blocked by proxy/Cloudflare)';
  }

  return body.length > 1000 ? `${body.slice(0, 1000)}...` : body;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


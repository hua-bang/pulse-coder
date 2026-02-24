import { readFile } from 'fs/promises';
import { getDiscordProxyDispatcher } from './proxy.js';

const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const DISCORD_MESSAGE_LIMIT = 2000;

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

export class DiscordClient {
  private readonly baseUrl: string;
  private readonly botToken: string;

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

  async sendChannelMessage(channelId: string, content: string): Promise<DiscordMessageResponse> {
    this.ensureBotToken();

    return this.request<DiscordMessageResponse>(
      `/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: limitDiscordContent(content) }),
      },
      true,
    );
  }

  async triggerTypingIndicator(channelId: string): Promise<void> {
    this.ensureBotToken();

    await this.request<void>(
      `/channels/${encodeURIComponent(channelId)}/typing`,
      {
        method: 'POST',
      },
      true,
    );
  }

  async editChannelMessage(channelId: string, messageId: string, content: string): Promise<void> {
    this.ensureBotToken();

    await this.request<void>(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: limitDiscordContent(content) }),
      },
      true,
    );
  }

  async sendChannelFile(
    channelId: string,
    filePath: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    content?: string,
  ): Promise<void> {
    this.ensureBotToken();

    const fileBuffer = await readFile(filePath);
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

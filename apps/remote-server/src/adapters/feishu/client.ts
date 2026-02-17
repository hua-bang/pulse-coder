import { createHmac } from 'crypto';

/**
 * Feishu (Lark) Bot API client using native fetch.
 * Handles tenant_access_token auto-refresh (expires every 2 hours).
 */
export class FeishuClient {
  private appId: string;
  private appSecret: string;
  private token: string | null = null;
  private tokenExpiry = 0;
  private readonly apiBase = 'https://open.feishu.cn/open-apis';

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    const res = await fetch(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const json = await res.json() as { code: number; tenant_access_token: string; expire: number; msg?: string };

    if (json.code !== 0) {
      throw new Error(`Feishu auth error: ${json.msg}`);
    }

    this.token = json.tenant_access_token;
    // expire is in seconds; subtract 60s buffer
    this.tokenExpiry = Date.now() + (json.expire - 60) * 1000;
    return this.token;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json() as { code: number; data: T; msg?: string };
    if (json.code !== 0) {
      throw new Error(`Feishu API error (${path}): ${json.msg} (code ${json.code})`);
    }
    return json.data;
  }

  /**
   * Send a plain text message to a chat.
   */
  async sendTextMessage(receiveId: string, receiveIdType: 'open_id' | 'chat_id', text: string): Promise<{ message_id: string }> {
    const data = await this.call<{ message_id: string }>('POST', '/im/v1/messages', {
      receive_id_type: receiveIdType,
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
    return data;
  }

  /**
   * Send a card message (interactive card with markdown body).
   */
  async sendCardMessage(receiveId: string, receiveIdType: 'open_id' | 'chat_id', cardContent: object): Promise<{ message_id: string }> {
    const data = await this.call<{ message_id: string }>('POST', '/im/v1/messages', {
      receive_id_type: receiveIdType,
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent),
    });
    return data;
  }

  /**
   * Update an existing card message.
   */
  async updateCardMessage(messageId: string, cardContent: object): Promise<void> {
    await this.call<void>('PATCH', `/im/v1/messages/${messageId}`, {
      content: JSON.stringify(cardContent),
    });
  }

  /**
   * Verify a Feishu webhook event signature.
   * https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/security-guidance/signature-verification
   */
  verifySignature(timestamp: string, nonce: string, encryptKey: string, body: string, signature: string): boolean {
    const payload = timestamp + nonce + encryptKey + body;
    const expected = createHmac('sha256', '').update(payload).digest('hex');
    return expected === signature;
  }
}

/**
 * Build a "thinking..." card to send while the agent is running.
 */
export function buildThinkingCard(): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{
        tag: 'markdown',
        content: '⏳ Working on it...',
      }],
    },
  };
}

/**
 * Build a progress card with accumulated text.
 */
export function buildProgressCard(text: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{
        tag: 'markdown',
        content: text || '⏳ Working on it...',
      }],
    },
  };
}

/**
 * Build a done card with the final result.
 */
export function buildDoneCard(text: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: true },
    body: {
      elements: [{
        tag: 'markdown',
        content: text || '✅ Done',
      }],
    },
  };
}

/**
 * Build an error card.
 */
export function buildErrorCard(message: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{
        tag: 'markdown',
        content: `❌ Error: ${message}`,
      }],
    },
  };
}

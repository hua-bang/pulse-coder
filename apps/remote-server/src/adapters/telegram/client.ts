/**
 * Minimal Telegram Bot API client using native fetch.
 * No SDK dependency — just a thin wrapper around the REST API.
 */

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
  };
}

export class TelegramClient {
  private baseUrl: string;

  constructor(private botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API error (${method}): ${json.description}`);
    }
    return json.result;
  }

  async sendMessage(chatId: number, text: string): Promise<{ message_id: number }> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4096), // Telegram max message length
      parse_mode: 'Markdown',
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4096),
        parse_mode: 'Markdown',
      });
    } catch (err) {
      // Ignore "message is not modified" errors (same content)
      if (!(err instanceof Error) || !err.message.includes('not modified')) {
        throw err;
      }
    }
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }
}

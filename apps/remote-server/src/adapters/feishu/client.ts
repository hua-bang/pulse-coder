import * as lark from '@larksuiteoapi/node-sdk';

/**
 * Create a Feishu SDK Client instance.
 * Token refresh, retry, and domain routing are all handled by the SDK.
 */
export function createLarkClient(): lark.Client {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  }
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
}

type ReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email';

/**
 * Send a plain text message.
 * Returns the message_id of the sent message.
 */
export async function sendTextMessage(
  client: lark.Client,
  receiveId: string,
  receiveIdType: ReceiveIdType,
  text: string,
): Promise<string> {
  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  return res.data?.message_id ?? '';
}

/**
 * Send an interactive card message.
 * Returns the message_id of the sent message.
 */
export async function sendCardMessage(
  client: lark.Client,
  receiveId: string,
  receiveIdType: ReceiveIdType,
  card: object,
): Promise<string> {
  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return res.data?.message_id ?? '';
}

/**
 * Update (patch) an existing card message with new content.
 */
export async function updateCardMessage(
  client: lark.Client,
  messageId: string,
  card: object,
): Promise<void> {
  await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
}

// ─── Card builders ────────────────────────────────────────────────────────────

export function buildThinkingCard(): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{ tag: 'markdown', content: '⏳ Working on it...' }],
    },
  };
}

export function buildProgressCard(text: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{ tag: 'markdown', content: text || '⏳ Working on it...' }],
    },
  };
}

export function buildDoneCard(text: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: true },
    body: {
      elements: [{ tag: 'markdown', content: text || '✅ Done' }],
    },
  };
}

export function buildErrorCard(message: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{ tag: 'markdown', content: `❌ Error: ${message}` }],
    },
  };
}

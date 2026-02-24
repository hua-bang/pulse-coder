import * as lark from '@larksuiteoapi/node-sdk';
import { readFile } from 'fs/promises';
import { basename } from 'path';

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


interface FeishuApiResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

let cachedTenantAccessToken: string | null = null;
let tenantAccessTokenExpiresAt = 0;

function getFeishuBaseUrl(): string {
  const envBaseUrl = process.env.FEISHU_API_BASE_URL?.trim();
  return (envBaseUrl || 'https://open.feishu.cn').replace(/\/$/, '');
}

async function getTenantAccessToken(): Promise<string> {
  if (cachedTenantAccessToken && Date.now() < tenantAccessTokenExpiresAt - 60_000) {
    return cachedTenantAccessToken;
  }

  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  }

  const response = await fetch(`${getFeishuBaseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get Feishu tenant access token: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = (await response.json()) as FeishuApiResponse<never> & {
    tenant_access_token?: string;
    expire?: number;
  };

  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Failed to get Feishu tenant access token: ${payload.msg || 'unknown error'}`);
  }

  cachedTenantAccessToken = payload.tenant_access_token;
  tenantAccessTokenExpiresAt = Date.now() + (payload.expire ?? 7200) * 1000;

  return cachedTenantAccessToken;
}

async function uploadImageToFeishu(imagePath: string, mimeType?: string): Promise<string> {
  const imageBuffer = await readFile(imagePath);
  if (imageBuffer.length === 0) {
    throw new Error(`Image file is empty: ${imagePath}`);
  }

  const token = await getTenantAccessToken();
  const formData = new FormData();
  const filename = basename(imagePath);

  formData.append('image_type', 'message');
  formData.append('image', new Blob([imageBuffer], { type: mimeType || 'image/png' }), filename);

  const response = await fetch(`${getFeishuBaseUrl()}/open-apis/im/v1/images`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to upload image to Feishu: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = (await response.json()) as FeishuApiResponse<{ image_key?: string }>;
  const imageKey = payload.data?.image_key;

  if (payload.code !== 0 || !imageKey) {
    throw new Error(`Failed to upload image to Feishu: ${payload.msg || 'unknown error'}`);
  }

  return imageKey;
}

type ReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email';

/**
 * Upload a local image and send it as a Feishu image message.
 * Returns the message_id of the sent message.
 */
export async function sendImageMessage(
  receiveId: string,
  receiveIdType: ReceiveIdType,
  imagePath: string,
  mimeType?: string,
): Promise<string> {
  const imageKey = await uploadImageToFeishu(imagePath, mimeType);
  const token = await getTenantAccessToken();

  const response = await fetch(
    `${getFeishuBaseUrl()}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to send image message to Feishu: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = (await response.json()) as FeishuApiResponse<{ message_id?: string }>;
  if (payload.code !== 0) {
    throw new Error(`Failed to send image message to Feishu: ${payload.msg || 'unknown error'}`);
  }

  return payload.data?.message_id ?? '';
}

/**
 * Add an emoji reaction to a message.
 */
export async function addMessageReaction(messageId: string, emojiType: string): Promise<void> {
  const token = await getTenantAccessToken();
  const normalizedEmojiType = emojiType.trim();
  if (!normalizedEmojiType) {
    throw new Error('emojiType is required');
  }

  const response = await fetch(
    `${getFeishuBaseUrl()}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        reaction_type: { emoji_type: normalizedEmojiType },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to add message reaction in Feishu: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = (await response.json()) as FeishuApiResponse<unknown>;
  if (payload.code !== 0) {
    throw new Error(`Failed to add message reaction in Feishu: ${payload.msg || 'unknown error'}`);
  }
}

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
      elements: [{ tag: 'markdown', content: 'Pulse is thinking...' }],
    },
  };
}

export function buildProgressCard(text: string): object {
  return {
    schema: '2.0',
    config: { enable_forward: false },
    body: {
      elements: [{ tag: 'markdown', content: text || 'Pulse is thinking...' }],
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

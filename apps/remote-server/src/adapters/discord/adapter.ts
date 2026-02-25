import { basename } from 'path';
import { existsSync } from 'fs';
import { createPublicKey, verify } from 'crypto';
import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/active-run-store.js';
import { extractGeminiImageResult } from '../feishu/image-result.js';
import { DiscordClient } from './client.js';
import { buildDiscordPlatformKey, isDiscordThreadChannelType } from './platform-key.js';

interface DiscordInteraction {
  id: string;
  application_id: string;
  token: string;
  type: number;
  channel_id?: string;
  guild_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: {
    name?: string;
    options?: DiscordCommandOption[];
  };
}

interface DiscordCommandOption {
  name?: string;
  value?: unknown;
  options?: DiscordCommandOption[];
}

type DiscordAckPayload =
  | { type: 1 }
  | { type: 4; data: { content: string; flags?: number } }
  | { type: 5 };

interface DiscordInteractionStreamMeta {
  kind: 'interaction';
  applicationId: string;
  interactionToken: string;
}

interface DiscordChannelStreamMeta {
  kind: 'channel';
  channelId: string;
}

type DiscordStreamMeta = DiscordInteractionStreamMeta | DiscordChannelStreamMeta;

type DiscordStreamIo = {
  updatePrimary: (content: string) => Promise<void>;
  sendExtraText: (content: string) => Promise<void>;
  sendExtraFile: (
    filePath: string,
    fileName: string,
    mimeType?: string,
    content?: string,
  ) => Promise<void>;
};

const DISCORD_ACK_EPHEMERAL_FLAG = 1 << 6;
const DISCORD_PROGRESS_UPDATE_INTERVAL_MS = 1200;
const DISCORD_MESSAGE_LIMIT = 2000;

export class DiscordAdapter implements PlatformAdapter {
  name = 'discord';

  private readonly client = new DiscordClient();
  private readonly rawBodyByRequest = new WeakMap<HonoRequest, string>();
  private readonly parsedByRequest = new WeakMap<HonoRequest, DiscordInteraction>();
  private readonly ackByRequest = new WeakMap<HonoRequest, DiscordAckPayload>();
  private readonly streamMetaByStreamId = new Map<string, DiscordStreamMeta>();
  private readonly streamMetaByPlatformKey = new Map<string, DiscordStreamMeta>();

  async verifyRequest(req: HonoRequest): Promise<boolean> {
    const publicKeyHex = process.env.DISCORD_PUBLIC_KEY?.trim();
    const signatureHex = req.header('x-signature-ed25519')?.trim();
    const timestamp = req.header('x-signature-timestamp')?.trim();

    if (!publicKeyHex || !signatureHex || !timestamp) {
      return false;
    }

    const rawBody = await this.getRawBody(req);
    if (!rawBody) {
      return false;
    }

    const message = Buffer.from(`${timestamp}${rawBody}`);

    try {
      const signature = Buffer.from(signatureHex, 'hex');
      const key = createPublicKey({
        key: Buffer.from(`302a300506032b6570032100${publicKeyHex}`, 'hex'),
        format: 'der',
        type: 'spki',
      });

      return verify(null, message, key, signature);
    } catch {
      return false;
    }
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    const interaction = await this.getInteraction(req);
    if (!interaction) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Invalid interaction payload.'));
      return null;
    }

    if (interaction.type === 1) {
      this.ackByRequest.set(req, { type: 1 });
      return null;
    }

    if (interaction.type !== 2) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Unsupported interaction type.'));
      return null;
    }

    const text = extractInteractionText(interaction);
    if (!text) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Please provide text input.'));
      return null;
    }

    const channelId = interaction.channel_id;
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!channelId || !userId) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Missing channel or user identity.'));
      return null;
    }

    const isGuildMessage = Boolean(interaction.guild_id);
    const channelType = isGuildMessage ? await this.client.getChannelType(channelId) : null;
    const isThread = isGuildMessage && isDiscordThreadChannelType(channelType);

    const platformKey = buildDiscordPlatformKey({
      guildId: interaction.guild_id,
      channelId,
      userId,
      isThread,
    });

    const activeStreamId = getActiveStreamId(platformKey);
    if (activeStreamId && clarificationQueue.hasPending(activeStreamId)) {
      const pending = clarificationQueue.getPending(activeStreamId);
      if (pending) {
        clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
      }
      this.ackByRequest.set(req, this.buildEphemeralMessage(`Got it: "${text}"`));
      return null;
    }

    const streamId = interaction.id;
    const streamMeta: DiscordInteractionStreamMeta = {
      kind: 'interaction',
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
    };

    this.streamMetaByStreamId.set(streamId, streamMeta);
    this.streamMetaByPlatformKey.set(platformKey, streamMeta);
    this.ackByRequest.set(req, { type: 5 });

    return { platformKey, text, streamId };
  }

  ackRequest(c: HonoContext, incoming: IncomingMessage | null): Response {
    const payload = this.ackByRequest.get(c.req)
      ?? (incoming ? { type: 5 } : this.buildEphemeralMessage('Ignored interaction.'));

    return c.json(payload, 200);
  }

  registerChannelStreamMeta(platformKey: string, streamId: string, channelId: string): void {
    const streamMeta: DiscordChannelStreamMeta = {
      kind: 'channel',
      channelId,
    };

    this.streamMetaByStreamId.set(streamId, streamMeta);
    this.streamMetaByPlatformKey.set(platformKey, streamMeta);
  }

  async tryHandleChannelClarification(platformKey: string, channelId: string, text: string): Promise<boolean> {
    const activeStreamId = getActiveStreamId(platformKey);
    if (!activeStreamId || !clarificationQueue.hasPending(activeStreamId)) {
      return false;
    }

    const pending = clarificationQueue.getPending(activeStreamId);
    if (!pending) {
      return false;
    }

    clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
    await this.client.sendChannelMessage(channelId, `Got it: "${text}"`).catch((err) => {
      console.error('[discord] Failed to send channel clarification ack:', err);
    });
    return true;
  }

  async createStreamHandle(incoming: IncomingMessage, streamId: string): Promise<StreamHandle> {
    const meta = this.streamMetaByStreamId.get(streamId)
      ?? this.streamMetaByPlatformKey.get(incoming.platformKey);
    if (!meta) {
      throw new Error('Missing Discord stream metadata.');
    }

    this.streamMetaByStreamId.delete(streamId);
    this.streamMetaByPlatformKey.delete(incoming.platformKey);

    if (meta.kind === 'interaction') {
      return this.createInteractionStreamHandle(meta);
    }

    return this.createChannelStreamHandle(meta);
  }

  private async createInteractionStreamHandle(meta: DiscordInteractionStreamMeta): Promise<StreamHandle> {
    return this.createStreamingHandle({
      updatePrimary: (content) => this.client.editOriginalResponse(meta.applicationId, meta.interactionToken, content),
      sendExtraText: (content) => this.client.createFollowupMessage(meta.applicationId, meta.interactionToken, content),
      sendExtraFile: (filePath, fileName, mimeType, content) => this.client.createFollowupFile(
        meta.applicationId,
        meta.interactionToken,
        filePath,
        fileName,
        mimeType,
        content,
      ),
    });
  }

  private async createChannelStreamHandle(meta: DiscordChannelStreamMeta): Promise<StreamHandle> {
    const initial = await this.client.sendChannelMessage(meta.channelId, 'Working on it...');

    return this.createStreamingHandle({
      updatePrimary: (content) => this.client.editChannelMessage(meta.channelId, initial.id, content),
      sendExtraText: async (content) => {
        await this.client.sendChannelMessage(meta.channelId, content);
      },
      sendExtraFile: (filePath, fileName, mimeType, content) => this.client.sendChannelFile(
        meta.channelId,
        filePath,
        fileName,
        mimeType,
        content,
      ),
    });
  }

  private createStreamingHandle(io: DiscordStreamIo): StreamHandle {
    const sentImagePaths = new Set<string>();
    let accumulatedText = '';
    let latestToolHint = '';
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let finalizing = false;

    const renderProgress = (): string => {
      if (!accumulatedText) {
        return latestToolHint || 'Working on it...';
      }
      return latestToolHint ? `${latestToolHint}\n\n${accumulatedText}` : accumulatedText;
    };

    const pushProgress = async () => {
      if (finalizing) {
        return;
      }
      await io.updatePrimary(renderProgress());
    };

    const scheduleProgress = () => {
      if (updateTimer || finalizing) {
        return;
      }

      updateTimer = setTimeout(async () => {
        updateTimer = null;
        await pushProgress().catch((err) => {
          console.error('[discord] Failed to update progress message:', err);
        });
      }, DISCORD_PROGRESS_UPDATE_INTERVAL_MS);
    };

    const clearProgressTimer = () => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }
    };

    const sendFinalText = async (text: string) => {
      const chunks = splitDiscordText(text);
      await io.updatePrimary(chunks[0]);

      for (const chunk of chunks.slice(1)) {
        await io.sendExtraText(chunk);
      }
    };

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleProgress();
      },

      async onToolCall(name, _input) {
        latestToolHint = `Tool: ${name}`;
        scheduleProgress();
      },

      async onToolResult(toolResult) {
        const imageResult = extractGeminiImageResult(toolResult);
        if (!imageResult) {
          return;
        }

        if (!existsSync(imageResult.outputPath) || sentImagePaths.has(imageResult.outputPath)) {
          return;
        }

        sentImagePaths.add(imageResult.outputPath);

        const fileName = basename(imageResult.outputPath);
        await io
          .sendExtraFile(
            imageResult.outputPath,
            fileName,
            imageResult.mimeType,
            `Generated image: ${fileName}`,
          )
          .catch((err) => {
            console.error('[discord] Failed to send generated image:', err);
          });
      },

      async onClarification(req: ClarificationRequest) {
        const question = req.context ? `${req.question}\n\nContext: ${req.context}` : req.question;
        await io.sendExtraText(`Question: ${question}`);
      },

      async onDone(result) {
        clearProgressTimer();
        finalizing = true;
        await sendFinalText(result || 'Done.').catch(async (err) => {
          console.error('[discord] Failed to send final response:', err);
          await io.sendExtraText(`Error: ${String(err)}`);
        });
      },

      async onError(err) {
        clearProgressTimer();
        finalizing = true;
        await sendFinalText(`Error: ${err.message}`).catch(async (followErr) => {
          console.error('[discord] Failed to send error response:', followErr);
          await io.sendExtraText(`Error: ${err.message}`);
        });
      },
    };
  }

  private buildEphemeralMessage(content: string): DiscordAckPayload {
    return {
      type: 4,
      data: {
        content,
        flags: DISCORD_ACK_EPHEMERAL_FLAG,
      },
    };
  }

  private async getRawBody(req: HonoRequest): Promise<string> {
    const cached = this.rawBodyByRequest.get(req);
    if (cached !== undefined) {
      return cached;
    }

    const text = await req.text();
    this.rawBodyByRequest.set(req, text);
    return text;
  }

  private async getInteraction(req: HonoRequest): Promise<DiscordInteraction | null> {
    const cached = this.parsedByRequest.get(req);
    if (cached) {
      return cached;
    }

    const rawBody = await this.getRawBody(req);
    if (!rawBody) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawBody) as DiscordInteraction;
      if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.application_id || !parsed.token) {
        return null;
      }

      this.parsedByRequest.set(req, parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}

export const discordAdapter = new DiscordAdapter();

const PASSTHROUGH_SLASH_COMMANDS = new Set([
  'help',
  'ping',
  'new',
  'restart',
  'clear',
  'reset',
  'compact',
  'current',
  'detach',
  'resume',
  'sessions',
  'status',
  'stop',
  'cancel',
  'skills',
]);

function extractInteractionText(interaction: DiscordInteraction): string {
  const commandName = interaction.data?.name?.trim().toLowerCase() ?? '';
  const args = collectOptionValues(interaction.data?.options ?? []).join(' ').trim();

  if (!commandName) {
    return '';
  }

  if (commandName === 'ask' || commandName === 'chat' || commandName === 'prompt') {
    return args;
  }

  if (PASSTHROUGH_SLASH_COMMANDS.has(commandName)) {
    return args ? `/${commandName} ${args}` : `/${commandName}`;
  }

  return args || commandName;
}

function collectOptionValues(options: DiscordCommandOption[]): string[] {
  const values: string[] = [];

  for (const option of options) {
    if (option.options && option.options.length > 0) {
      values.push(...collectOptionValues(option.options));
      continue;
    }

    if (option.value === undefined || option.value === null) {
      continue;
    }

    values.push(String(option.value));
  }

  return values;
}

function splitDiscordText(text: string): string[] {
  const normalized = text.trim() || 'Done.';
  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    chunks.push(normalized.slice(cursor, cursor + DISCORD_MESSAGE_LIMIT));
    cursor += DISCORD_MESSAGE_LIMIT;
  }

  return chunks;
}

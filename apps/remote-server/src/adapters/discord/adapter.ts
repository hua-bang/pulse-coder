import { basename } from 'path';
import { existsSync } from 'fs';
import { createPublicKey, verify } from 'crypto';
import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/active-run-store.js';
import { extractGeminiImageResult } from '../feishu/image-result.js';
import type { DiscordButtonComponent, DiscordMessageComponent } from './client.js';
import { DiscordClient } from './client.js';
import { buildDiscordMemoryKey, buildDiscordPlatformKey, isDiscordThreadChannelType } from './platform-key.js';

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
    custom_id?: string;
    component_type?: number;
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
  | { type: 5 }
  | { type: 7; data: { content?: string; components?: DiscordMessageComponent[] } };

interface DiscordInteractionStreamMeta {
  kind: 'interaction';
  applicationId: string;
  interactionToken: string;
}

interface DiscordChannelStreamMeta {
  kind: 'channel';
  channelId: string;
  isThread: boolean;
  replyToMessageId?: string;
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
  sendExtraTextWithComponents?: (content: string, components: DiscordMessageComponent[]) => Promise<void>;
};

interface DiscordClarificationButtons {
  streamId: string;
  clarificationId: string;
  messageId?: string;
  components?: DiscordMessageComponent[];
  labels?: string[];
}

const DISCORD_ACK_EPHEMERAL_FLAG = 1 << 6;
const DISCORD_PROGRESS_UPDATE_INTERVAL_MS = 5000;
const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_PROGRESS_FOOTER_BASE = 'Pulse Agent 努力生成中';
const DISCORD_PROGRESS_DOT_MIN = 1;
const DISCORD_PROGRESS_DOT_MAX = 5;
const DISCORD_BUTTON_STYLE_PRIMARY = 1;
const DISCORD_BUTTON_STYLE_SECONDARY = 2;
const DISCORD_BUTTON_STYLE_SUCCESS = 3;
const DISCORD_BUTTON_STYLE_DANGER = 4;
const DISCORD_BUTTON_CUSTOM_ID_PREFIX = 'clarify:';

export class DiscordAdapter implements PlatformAdapter {
  name = 'discord';

  private readonly client = new DiscordClient();
  private readonly rawBodyByRequest = new WeakMap<HonoRequest, string>();
  private readonly parsedByRequest = new WeakMap<HonoRequest, DiscordInteraction>();
  private readonly ackByRequest = new WeakMap<HonoRequest, DiscordAckPayload>();
  private readonly streamMetaByStreamId = new Map<string, DiscordStreamMeta>();
  private readonly streamMetaByPlatformKey = new Map<string, DiscordStreamMeta>();
  private readonly clarificationButtonsByStreamId = new Map<string, DiscordClarificationButtons>();

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

    if (interaction.type === 3) {
      return this.handleComponentInteraction(req, interaction);
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
    const memoryKey = buildDiscordMemoryKey(userId);

    const activeStreamId = getActiveStreamId(platformKey);
    if (activeStreamId && clarificationQueue.hasPending(activeStreamId)) {
      const pending = clarificationQueue.getPending(activeStreamId);
      if (pending) {
        clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
        await this.clearClarificationButtons(activeStreamId, `Got it: "${text}"`);
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

    return { platformKey, memoryKey, text, streamId };
  }

  ackRequest(c: HonoContext, incoming: IncomingMessage | null): Response {
    const payload = this.ackByRequest.get(c.req)
      ?? (incoming ? { type: 5 } : this.buildEphemeralMessage('Ignored interaction.'));

    return c.json(payload, 200);
  }

  registerChannelStreamMeta(
    platformKey: string,
    streamId: string,
    channelId: string,
    isThread = false,
    replyToMessageId?: string,
  ): void {
    const streamMeta: DiscordChannelStreamMeta = {
      kind: 'channel',
      channelId,
      isThread,
      replyToMessageId,
    };

    this.streamMetaByStreamId.set(streamId, streamMeta);
    this.streamMetaByPlatformKey.set(platformKey, streamMeta);
  }

  async tryHandleChannelClarification(
    platformKey: string,
    channelId: string,
    text: string,
    isThread = false,
  ): Promise<boolean> {
    const activeStreamId = getActiveStreamId(platformKey);
    if (!activeStreamId || !clarificationQueue.hasPending(activeStreamId)) {
      return false;
    }

    const pending = clarificationQueue.getPending(activeStreamId);
    if (!pending) {
      return false;
    }

    clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
    const didUpdate = await this.clearClarificationButtons(activeStreamId, `Got it: "${text}"`, { channelId, isThread });
    if (!didUpdate) {
      await this.client.sendChannelMessage(channelId, `Got it: "${text}"`, { assumeThread: isThread }).catch((err) => {
        console.error('[discord] Failed to send channel clarification ack:', err);
      });
    }
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

    return this.createStreamingHandle(streamId, meta);
  }

  private async createStreamingHandle(
    streamId: string,
    meta: DiscordStreamMeta,
  ): Promise<StreamHandle> {
    if (meta.kind === 'interaction') {
      return this.createInteractionStreamHandle(streamId, meta);
    }

    return this.createChannelStreamHandle(streamId, meta);
  }

  private async createInteractionStreamHandle(
    streamId: string,
    meta: DiscordInteractionStreamMeta,
  ): Promise<StreamHandle> {
    return this.createStreamingHandleForIo(streamId, {
      updatePrimary: (content) => this.client.editOriginalResponse(meta.applicationId, meta.interactionToken, content),
      sendExtraText: (content) => this.client.createFollowupMessage(meta.applicationId, meta.interactionToken, content),
      sendExtraTextWithComponents: (content, components) => this.client.createFollowupMessageWithComponents(
        meta.applicationId,
        meta.interactionToken,
        content,
        components,
      ),
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

  private async createChannelStreamHandle(
    streamId: string,
    meta: DiscordChannelStreamMeta,
  ): Promise<StreamHandle> {
    const initial = await this.client.sendChannelMessage(meta.channelId, 'Working on it...', {
      assumeThread: meta.isThread,
      replyToMessageId: meta.replyToMessageId,
    });

    return this.createStreamingHandleForIo(streamId, {
      updatePrimary: (content) => this.client.editChannelMessage(meta.channelId, initial.id, content, {
        assumeThread: meta.isThread,
      }),
      sendExtraText: async (content) => {
        await this.client.sendChannelMessage(meta.channelId, content, { assumeThread: meta.isThread });
      },
      sendExtraTextWithComponents: async (content, components) => {
        const message = await this.client.sendChannelMessage(meta.channelId, content, {
          assumeThread: meta.isThread,
          components,
        });
        this.storeClarificationMessage(streamId, message.id, components);
      },
      sendExtraFile: (filePath, fileName, mimeType, content) => this.client.sendChannelFile(
        meta.channelId,
        filePath,
        fileName,
        mimeType,
        content,
        { assumeThread: meta.isThread },
      ),
    });
  }

  private createStreamingHandleForIo(streamId: string, io: DiscordStreamIo): StreamHandle {
    const adapter = this;
    const sentImagePaths = new Set<string>();
    let accumulatedText = '';
    let latestToolHint = '';
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let animationTimer: ReturnType<typeof setInterval> | null = null;
    let finalizing = false;
    let progressFrame = 0;
    let primaryWriteChain: Promise<void> = Promise.resolve();

    const enqueuePrimaryWrite = (
      write: () => Promise<void>,
      options: { onError?: (err: unknown) => void; propagate?: boolean } = {},
    ): Promise<void> => {
      const run = primaryWriteChain.then(write);
      primaryWriteChain = run.catch((err) => {
        options.onError?.(err);
      });
      return options.propagate ? run : primaryWriteChain;
    };

    const renderProgress = (): string => {
      const body = !accumulatedText
        ? (latestToolHint || 'Working on it...')
        : (latestToolHint ? `${latestToolHint}\n\n${accumulatedText}` : accumulatedText);

      const rendered = renderDiscordProgressWithFooter(body, progressFrame);
      const frameCount = DISCORD_PROGRESS_DOT_MAX - DISCORD_PROGRESS_DOT_MIN + 1;
      progressFrame = (progressFrame + 1) % frameCount;
      return rendered;
    };

    const pushProgress = async () => {
      if (finalizing) {
        return;
      }
      await enqueuePrimaryWrite(
        () => io.updatePrimary(renderProgress()),
        {
          onError: (err) => {
            console.error('[discord] Failed to update progress message:', err);
          },
        },
      );
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

    const ensureProgressAnimation = () => {
      if (animationTimer || finalizing) {
        return;
      }

      animationTimer = setInterval(() => {
        if (updateTimer || finalizing) {
          return;
        }

        pushProgress().catch((err) => {
          console.error('[discord] Failed to animate progress message:', err);
        });
      }, DISCORD_PROGRESS_UPDATE_INTERVAL_MS);
    };

    const clearProgressTimers = () => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }

      if (animationTimer) {
        clearInterval(animationTimer);
        animationTimer = null;
      }
    };

    const sendFinalText = async (text: string) => {
      const chunks = splitDiscordText(text);
      await enqueuePrimaryWrite(
        () => io.updatePrimary(chunks[0]),
        { propagate: true },
      );

      for (const chunk of chunks.slice(1)) {
        await io.sendExtraText(chunk);
      }
    };

    scheduleProgress();
    ensureProgressAnimation();

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleProgress();
        ensureProgressAnimation();
      },

      async onToolCall(name, input) {
        latestToolHint = formatDiscordToolHint(name, input);
        scheduleProgress();
        ensureProgressAnimation();
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
        const options = parseClarificationOptions(req);
        if (!io.sendExtraTextWithComponents || options.length === 0) {
          await io.sendExtraText(`Question: ${question}`);
          return;
        }

        const components = buildClarificationButtons(req.id, options);
        await io.sendExtraTextWithComponents(`Question: ${question}`, components);
        const labels = options.map((option) => option.label);
        adapter.storeClarificationButtons(streamId, req.id, components, labels);
      },

      async onDone(result) {
        clearProgressTimers();
        finalizing = true;
        await sendFinalText(result || 'Done.').catch(async (err) => {
          console.error('[discord] Failed to send final response:', err);
          await io.sendExtraText(`Error: ${String(err)}`);
        });
      },

      async onError(err) {
        clearProgressTimers();
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

  private async handleComponentInteraction(
    req: HonoRequest,
    interaction: DiscordInteraction,
  ): Promise<IncomingMessage | null> {
    if (!interaction.data?.custom_id) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Missing interaction payload.'));
      return null;
    }

    const channelId = interaction.channel_id;
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!channelId || !userId) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Missing channel or user identity.'));
      return null;
    }

    const parsed = parseClarificationCustomId(interaction.data.custom_id);
    if (!parsed) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Unsupported interaction type.'));
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
    if (!activeStreamId || !clarificationQueue.hasPending(activeStreamId)) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('No active clarification to answer.'));
      return null;
    }

    const pending = clarificationQueue.getPending(activeStreamId);
    if (!pending || pending.request.id !== parsed.clarificationId) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Clarification no longer active.'));
      return null;
    }

    const optionLabel = this.resolveClarificationLabel(activeStreamId, parsed.optionIndex);
    if (!optionLabel) {
      this.ackByRequest.set(req, this.buildEphemeralMessage('Invalid clarification option.'));
      return null;
    }

    clarificationQueue.submitAnswer(activeStreamId, pending.request.id, optionLabel);

    this.clearClarificationState(activeStreamId);
    this.ackByRequest.set(req, {
      type: 7,
      data: {
        content: `Got it: "${optionLabel}"`,
        components: [],
      },
    });
    return null;
  }

  private clearClarificationState(streamId: string): void {
    const record = this.clarificationButtonsByStreamId.get(streamId);
    if (!record) {
      return;
    }

    this.clarificationButtonsByStreamId.delete(record.streamId);
    this.clarificationButtonsByStreamId.delete(record.clarificationId);
  }

  private storeClarificationButtons(
    streamId: string,
    clarificationId: string,
    components: DiscordMessageComponent[],
    labels: string[],
  ): void {
    const existing = this.clarificationButtonsByStreamId.get(streamId);
    if (existing) {
      const previousClarificationId = existing.clarificationId;
      existing.clarificationId = clarificationId;
      existing.components = components;
      existing.labels = labels;

      if (
        previousClarificationId &&
        previousClarificationId !== clarificationId &&
        previousClarificationId !== streamId
      ) {
        this.clarificationButtonsByStreamId.delete(previousClarificationId);
      }

      this.clarificationButtonsByStreamId.set(clarificationId, existing);
      return;
    }

    const record: DiscordClarificationButtons = {
      streamId,
      clarificationId,
      components,
      labels,
    };
    this.clarificationButtonsByStreamId.set(streamId, record);
    this.clarificationButtonsByStreamId.set(clarificationId, record);
  }

  private storeClarificationMessage(
    streamId: string,
    messageId: string,
    components: DiscordMessageComponent[],
  ): void {
    const record = this.clarificationButtonsByStreamId.get(streamId);
    if (!record) {
      const placeholder: DiscordClarificationButtons = {
        streamId,
        clarificationId: streamId,
        components,
        labels: [],
        messageId,
      };
      this.clarificationButtonsByStreamId.set(streamId, placeholder);
      return;
    }

    if (this.clarificationButtonsByStreamId.get(record.clarificationId) !== record) {
      this.clarificationButtonsByStreamId.set(record.clarificationId, record);
    }

    record.messageId = messageId;
    if (!record.components || record.components.length === 0) {
      record.components = components;
    }
  }

  private resolveClarificationLabel(streamId: string, optionIndex: number): string | undefined {
    const record = this.clarificationButtonsByStreamId.get(streamId);
    if (!record?.labels || optionIndex < 0 || optionIndex >= record.labels.length) {
      return undefined;
    }

    return record.labels[optionIndex];
  }

  private async clearClarificationButtons(
    streamId: string,
    content: string,
    channelMeta?: { channelId: string; isThread: boolean },
  ): Promise<boolean> {
    const record = this.clarificationButtonsByStreamId.get(streamId);
    if (!record) {
      return false;
    }

    this.clearClarificationState(streamId);

    if (channelMeta && record.messageId) {
      try {
        await this.client.editChannelMessage(channelMeta.channelId, record.messageId, content, {
          assumeThread: channelMeta.isThread,
          components: [],
        });
        return true;
      } catch (err) {
        console.error('[discord] Failed to clear clarification buttons:', err);
      }

      await this.client
        .sendChannelMessage(channelMeta.channelId, content, { assumeThread: channelMeta.isThread })
        .catch((sendErr) => {
          console.error('[discord] Failed to send clarification followup:', sendErr);
        });
      return true;
    }

    if (channelMeta) {
      await this.client
        .sendChannelMessage(channelMeta.channelId, content, { assumeThread: channelMeta.isThread })
        .catch((err) => {
          console.error('[discord] Failed to send clarification followup:', err);
        });
      return true;
    }

    return false;
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
  'fork',
  'status',
  'stop',
  'cancel',
  'skills',
  'soul',
  'insight',
  'model',
  'wt',
]);

function extractInteractionText(interaction: DiscordInteraction): string {
  const commandName = interaction.data?.name?.trim().toLowerCase() ?? '';
  const args = collectOptionTokens(interaction.data?.options ?? []).join(' ').trim();

  if (!commandName) {
    return '';
  }

  if (commandName === 'ask' || commandName === 'chat' || commandName === 'prompt') {
    return args;
  }

  if (commandName === 'restart') {
    return buildRestartCommandText(interaction.data?.options ?? []);
  }

  if (PASSTHROUGH_SLASH_COMMANDS.has(commandName)) {
    if (commandName === 'wt') {
      const values = collectOptionValues(interaction.data?.options ?? []);
      const normalizedValues = values.map((value) => value.trim()).filter(Boolean);
      const argText = normalizedValues.join(' ');
      return argText ? `/${commandName} ${argText}` : `/${commandName}`;
    }
    return args ? `/${commandName} ${args}` : `/${commandName}`;
  }

  return args || commandName;
}

function buildRestartCommandText(options: DiscordCommandOption[]): string {
  const modeRaw = findOptionValue(options, 'mode');
  const branchRaw = findOptionValue(options, 'branch');

  const mode = modeRaw ? modeRaw.toLowerCase() : '';
  const branch = branchRaw?.trim() || '';

  if (mode === 'status') {
    return '/restart status';
  }

  if (mode === 'update') {
    return branch ? `/restart update ${branch}` : '/restart update';
  }

  if (!mode && branch) {
    return `/restart update ${branch}`;
  }

  if (mode) {
    return branch ? `/restart ${mode} ${branch}` : `/restart ${mode}`;
  }

  return '/restart';
}

function findOptionValue(options: DiscordCommandOption[], targetName: string): string | undefined {
  for (const option of options) {
    const optionName = option.name?.trim().toLowerCase();
    if (optionName === targetName && option.value !== undefined && option.value !== null) {
      return String(option.value);
    }

    if (option.options && option.options.length > 0) {
      const nested = findOptionValue(option.options, targetName);
      if (nested !== undefined) {
        return nested;
      }
    }
  }

  return undefined;
}

function collectOptionTokens(options: DiscordCommandOption[]): string[] {
  const tokens: string[] = [];

  for (const option of options) {
    if (option.options && option.options.length > 0) {
      tokens.push(...collectOptionTokens(option.options));
      continue;
    }

    const name = option.name?.trim();
    if (name) {
      tokens.push(name);
    }

    if (option.value === undefined || option.value === null) {
      continue;
    }

    tokens.push(String(option.value));
  }

  return tokens;
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

function formatDiscordToolHint(name: string, input: unknown): string {
  const toolName = name.trim() || 'unknown';
  const serializedInput = serializeToolInputForDiscord(input);

  if (!serializedInput) {
    return `Tool: ${toolName}`;
  }

  return `Tool: ${toolName}\nArgs: ${serializedInput}`;
}

function serializeToolInputForDiscord(input: unknown): string {
  if (input === undefined || input === null) {
    return '';
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed ? trimDiscordToolInput(trimmed) : '';
  }

  try {
    const serialized = JSON.stringify(input);
    if (!serialized || serialized === '{}' || serialized === '[]') {
      return '';
    }
    return trimDiscordToolInput(serialized);
  } catch {
    return '[unserializable]';
  }
}

function trimDiscordToolInput(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  const maxLength = 220;
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function renderDiscordProgressWithFooter(content: string, frame: number): string {
  const footer = buildDiscordProgressFooter(frame);
  const normalizedContent = content.trim() || 'Working on it...';
  const separator = '\n\n';
  const reservedLength = separator.length + footer.length;
  const maxContentLength = DISCORD_MESSAGE_LIMIT - reservedLength;

  if (maxContentLength <= 0) {
    return footer.slice(0, DISCORD_MESSAGE_LIMIT);
  }

  const clippedContent = normalizedContent.length <= maxContentLength
    ? normalizedContent
    : `${normalizedContent.slice(0, maxContentLength - 3)}...`;

  return `${clippedContent}${separator}${footer}`;
}

function buildDiscordProgressFooter(frame: number): string {
  const dotRange = DISCORD_PROGRESS_DOT_MAX - DISCORD_PROGRESS_DOT_MIN + 1;
  const dotCount = DISCORD_PROGRESS_DOT_MIN + (Math.abs(frame) % dotRange);
  return `${DISCORD_PROGRESS_FOOTER_BASE}${'.'.repeat(dotCount)}`;
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

function parseClarificationOptions(request: ClarificationRequest): Array<{ label: string }> {
  if (!request.context) {
    return [];
  }

  const lines = request.context.split('\n');
  const options: Array<{ label: string }> = [];
  let inOptions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (!inOptions) {
      if (/^options:/i.test(trimmed)) {
        inOptions = true;
      }
      continue;
    }

    const match = trimmed.match(/^(\d+)[\.)]\s+(.*)$/);
    if (!match) {
      continue;
    }

    const label = match[2]?.trim();
    if (!label) {
      continue;
    }

    options.push({ label });
  }

  return options;
}

function buildClarificationButtons(clarificationId: string, options: Array<{ label: string }>): DiscordMessageComponent[] {
  const rows: DiscordMessageComponent[] = [];
  let row: DiscordButtonComponent[] = [];

  options.slice(0, 10).forEach((option, index) => {
    if (row.length === 5) {
      rows.push({ type: 1, components: row });
      row = [];
    }

    row.push({
      type: 2,
      style: resolveButtonStyle(index, option.label),
      label: option.label.slice(0, 80),
      custom_id: buildClarificationCustomId(clarificationId, index),
    });
  });

  if (row.length > 0) {
    rows.push({ type: 1, components: row });
  }

  return rows;
}

function resolveButtonStyle(index: number, label: string): DiscordButtonComponent['style'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('deny') || normalized.includes('reject') || normalized.includes('cancel') || normalized.includes('no')) {
    return DISCORD_BUTTON_STYLE_DANGER;
  }

  if (normalized.includes('allow') || normalized.includes('approve') || normalized.includes('yes') || normalized.includes('ok')) {
    return DISCORD_BUTTON_STYLE_SUCCESS;
  }

  if (index === 0) {
    return DISCORD_BUTTON_STYLE_PRIMARY;
  }

  return DISCORD_BUTTON_STYLE_SECONDARY;
}

function buildClarificationCustomId(clarificationId: string, index: number): string {
  return `${DISCORD_BUTTON_CUSTOM_ID_PREFIX}${clarificationId}|${index}`;
}

function parseClarificationCustomId(customId: string): { clarificationId: string; optionIndex: number } | null {
  if (!customId.startsWith(DISCORD_BUTTON_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const payload = customId.slice(DISCORD_BUTTON_CUSTOM_ID_PREFIX.length);
  const [clarificationId, indexRaw] = payload.split('|');
  if (!clarificationId || !indexRaw) {
    return null;
  }

  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }

  return { clarificationId, optionIndex: index };
}

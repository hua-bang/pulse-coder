export const DISCORD_THREAD_CHANNEL_TYPES = new Set<number>([10, 11, 12]);

export function isDiscordThreadChannelType(channelType: number | null | undefined): boolean {
  if (typeof channelType !== 'number') {
    return false;
  }

  return DISCORD_THREAD_CHANNEL_TYPES.has(channelType);
}

export function buildDiscordPlatformKey(options: {
  guildId?: string;
  channelId: string;
  userId: string;
  isThread: boolean;
}): string {
  const { guildId, channelId, userId, isThread } = options;

  if (!guildId) {
    return `discord:${userId}`;
  }

  if (isThread) {
    return `discord:thread:${channelId}`;
  }

  return `discord:channel:${channelId}:${userId}`;
}

export function buildDiscordMemoryKey(userId: string): string {
  return `discord:user:${userId}`;
}

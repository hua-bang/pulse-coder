
import { DiscordClient, type DiscordApplicationCommandCreate } from './client.js';

const RESTART_COMMAND: DiscordApplicationCommandCreate = {
  name: 'restart',
  description: 'Restart process, check status, or update branch then restart.',
  options: [
    {
      type: 3,
      name: 'mode',
      description: 'Optional mode: status or update.',
      required: false,
      max_length: 16,
    },
    {
      type: 3,
      name: 'branch',
      description: 'Branch used when mode=update (default: master).',
      required: false,
      max_length: 64,
    },
  ],
};

const WORKTREE_COMMAND: DiscordApplicationCommandCreate = {
  name: 'wt',
  description: 'Bind or inspect worktree state.',
  options: [
    {
      type: 3,
      name: 'command',
      description: 'Command text, e.g. "use feat-refactor-commands" or "status".',
      required: false,
    },
  ],
};

const SKILLS_COMMAND: DiscordApplicationCommandCreate = {
  name: 'skills',
  description: 'Open the Pulse skill launcher.',
};

// Right-click message → Apps → "Ask Pulse" sends the message content as a prompt.
const ASK_PULSE_MESSAGE_COMMAND: DiscordApplicationCommandCreate = {
  name: 'Ask Pulse',
  type: 3,
};

export async function registerDiscordApplicationCommands(): Promise<void> {
  if (!parseEnabledFlag(process.env.DISCORD_COMMAND_REGISTER_ENABLED, true)) {
    console.log('[discord] Skip app command registration: DISCORD_COMMAND_REGISTER_ENABLED=false');
    return;
  }

  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    console.log('[discord] Skip app command registration: DISCORD_BOT_TOKEN is not set');
    return;
  }

  const client = new DiscordClient();
  const configuredApplicationId = process.env.DISCORD_APPLICATION_ID?.trim();
  const applicationId = configuredApplicationId || await client.getApplicationId();
  const guildIds = parseGuildIds(process.env.DISCORD_COMMAND_GUILD_IDS);
  const commands = [RESTART_COMMAND, WORKTREE_COMMAND, SKILLS_COMMAND, ASK_PULSE_MESSAGE_COMMAND];

  if (guildIds.length === 0) {
    for (const command of commands) {
      await client.upsertGlobalApplicationCommand(applicationId, command);
      console.log(`[discord] Registered global application command: /${command.name}`);
    }
    return;
  }

  for (const guildId of guildIds) {
    for (const command of commands) {
      await client.upsertGuildApplicationCommand(applicationId, guildId, command);
    }
  }

  console.log(`[discord] Registered guild application commands for ${guildIds.length} guild(s)`);
}

function parseGuildIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^\d+$/.test(value)) {
      continue;
    }

    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function parseEnabledFlag(value: string | undefined, defaultValue = true): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }

  return true;
}

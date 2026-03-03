import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import z from 'zod';
import type { Tool, ToolExecutionContext } from 'pulse-coder-engine';
import { createLarkClient, sendTextMessage } from '../../adapters/feishu/client.js';
import { DiscordClient } from '../../adapters/discord/client.js';

const execFileAsync = promisify(execFile);

const APP_DIR = '/root/pulse-coder/apps/remote-server';
const REQUEST_URL = 'http://127.0.0.1:3000/internal/agent/run';
const DEFAULT_SCHEDULE = '5 9 * * *';
const DEFAULT_ASK_POLICY: AskPolicy = 'never';
const DEFAULT_FORCE_NEW_SESSION = true;
const DEFAULT_SKILL_PROMPT = 'Please execute this skill and return the final result.';

const CRON_BEGIN_PREFIX = '# BEGIN pulse-cron:';
const CRON_END_PREFIX = '# END pulse-cron:';

const toolSchema = z.object({
  intent: z.string().optional().describe('What the job should run. Used to generate the job slug when name is missing.'),
  schedule: z.string().optional().describe('Cron schedule, for example "5 9 * * *".'),
  name: z.string().optional().describe('Job name. If provided, it is used to derive the job slug.'),
  skill: z.string().optional().describe('Skill name to invoke on run.'),
  prompt: z.string().optional().describe('Prompt message to send.'),
  platformKey: z.string().optional().describe('Platform key for the agent run session and notify inference.'),
  askPolicy: z.enum(['never', 'default']).optional().describe('Clarification policy for agent run.'),
  forceNewSession: z.boolean().optional().describe('Whether to force a new session per run.'),
  timezone: z.string().optional().describe('Optional CRON_TZ value, for example "Asia/Shanghai".'),
  notify: z
    .object({
      feishu: z
        .object({
          receiveId: z.string().optional(),
          receiveIdType: z.enum(['open_id', 'chat_id', 'user_id', 'union_id', 'email']).optional(),
        })
        .optional(),
      discord: z
        .object({
          channelId: z.string().optional(),
          isThread: z.boolean().optional(),
        })
        .optional(),
    })
    .optional()
    .describe('Explicit notify target override.'),
  dryRun: z.boolean().optional().describe('If true, skip writing script/cron and return the planned changes.'),
});

type AskPolicy = 'never' | 'default';

interface CronJobInput extends z.infer<typeof toolSchema> {}

interface CronJobResult {
  ok: boolean;
  jobSlug: string;
  scriptPath: string;
  schedule: string;
  logPath: string;
  lockPath: string;
  cronLine: string;
  timezone?: string;
  notify?: NotifyTarget;
  dryRun?: boolean;
  validation?: {
    scriptSyntax: boolean;
    cronInstalled: boolean;
  };
  rollback: {
    removeCron: string;
    removeScript: string;
  };
  warning?: string;
}

interface FeishuNotifyTarget {
  receiveId: string;
  receiveIdType: 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email';
}

interface DiscordNotifyTarget {
  channelId: string;
  isThread: boolean;
}

interface NotifyTarget {
  feishu?: FeishuNotifyTarget;
  discord?: DiscordNotifyTarget;
}

export const cronJobTool: Tool<CronJobInput, CronJobResult> = {
  name: 'cron_job',
  description: 'Create or update a cron runner that calls /internal/agent/run with optional notify targets.',
  inputSchema: toolSchema,
  execute: async (input, context?: ToolExecutionContext) => {
    const normalized = normalizeInput(input, context?.runContext);

    const schedule = normalized.schedule;
    const jobSlug = normalized.jobSlug;
    const scriptPath = `/root/.local/bin/remote-server-${jobSlug}-cron.sh`;
    const logPath = `/tmp/remote-server-${jobSlug}-cron.log`;
    const lockPath = `/tmp/remote-server-${jobSlug}.lock`;
    const cronLine = `${schedule} ${scriptPath} >> ${logPath} 2>&1`;

    const rollback = {
      removeCron: `crontab -l | sed '/${escapeSed(jobSlug, CRON_BEGIN_PREFIX)}/,/${escapeSed(jobSlug, CRON_END_PREFIX)}/d' | crontab -`,
      removeScript: `rm -f ${scriptPath}`,
    };

    if (normalized.dryRun) {
      return {
        ok: true,
        jobSlug,
        scriptPath,
        schedule,
        logPath,
        lockPath,
        cronLine,
        timezone: normalized.timezone,
        notify: normalized.notify,
        dryRun: true,
        rollback,
      };
    }

    await ensureDir(path.dirname(scriptPath));
    const scriptContents = buildRunnerScript({
      appDir: APP_DIR,
      requestUrl: REQUEST_URL,
      lockPath,
      prompt: normalized.prompt,
      skill: normalized.skill,
      platformKey: normalized.platformKey,
      askPolicy: normalized.askPolicy,
      forceNewSession: normalized.forceNewSession,
      notify: normalized.notify,
    });

    await fs.writeFile(scriptPath, scriptContents, { encoding: 'utf8', mode: 0o700 });

    const cronBlock = buildCronBlock({
      jobSlug,
      schedule,
      scriptPath,
      logPath,
      timezone: normalized.timezone,
    });

    const existing = await readCrontab();
    const updated = upsertCronBlock(existing, jobSlug, cronBlock);
    if (updated !== existing) {
      await writeCrontab(updated);
    }

    const validation = {
      scriptSyntax: await validateScript(scriptPath),
      cronInstalled: await verifyCronBlock(jobSlug),
    };

    if (normalized.notify?.feishu || normalized.notify?.discord) {
      await sendSetupNotification({
        notify: normalized.notify,
        jobSlug,
        schedule,
        timezone: normalized.timezone,
      });
    } else if (normalized.notifyRequested) {
      return {
        ok: false,
        jobSlug,
        scriptPath,
        schedule,
        logPath,
        lockPath,
        cronLine,
        timezone: normalized.timezone,
        notify: normalized.notify,
        validation,
        rollback,
        warning: 'Notify requested but no platform target could be inferred from platformKey.',
      };
    }

    return {
      ok: validation.scriptSyntax && validation.cronInstalled,
      jobSlug,
      scriptPath,
      schedule,
      logPath,
      lockPath,
      cronLine,
      timezone: normalized.timezone,
      notify: normalized.notify,
      validation,
      rollback,
    };
  },
};

interface NormalizedInput {
  schedule: string;
  jobSlug: string;
  prompt: string;
  skill?: string;
  platformKey: string;
  askPolicy: AskPolicy;
  forceNewSession: boolean;
  timezone?: string;
  notify?: NotifyTarget;
  notifyRequested: boolean;
  dryRun: boolean;
}

interface RunContextInput {
  platformKey?: string;
}

function normalizeInput(input: CronJobInput, runContext?: RunContextInput): NormalizedInput {
  const schedule = input.schedule?.trim() || DEFAULT_SCHEDULE;
  const baseName = input.name?.trim() || input.intent?.trim() || 'agent-task';
  const jobSlug = slugify(baseName);
  const platformKey = input.platformKey?.trim() || runContext?.platformKey || `internal:cron:${jobSlug}`;
  const askPolicy = input.askPolicy ?? DEFAULT_ASK_POLICY;
  const forceNewSession = input.forceNewSession ?? DEFAULT_FORCE_NEW_SESSION;
  const prompt = (input.prompt && input.prompt.trim()) || DEFAULT_SKILL_PROMPT;
  const skill = input.skill?.trim() || undefined;
  const timezone = input.timezone?.trim() || undefined;
  const notifyRequested = Boolean(input.notify) || isNotifyRequested(prompt);
  const notify = normalizeNotify(input.notify, platformKey, notifyRequested ? prompt : undefined);
  const dryRun = input.dryRun === true;

  return {
    schedule,
    jobSlug,
    prompt,
    skill,
    platformKey,
    askPolicy,
    forceNewSession,
    timezone,
    notify,
    notifyRequested,
    dryRun,
  };
}

function slugify(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-]+|[-]+$/g, '');

  return cleaned || 'agent-task';
}

function normalizeNotify(
  input: CronJobInput['notify'],
  platformKey: string,
  prompt?: string,
): NotifyTarget | undefined {
  const explicit = normalizeExplicitNotify(input);
  const inferred = inferNotifyFromPlatformKey(platformKey);
  const wantsNotify = isNotifyRequested(prompt);

  if (explicit) {
    return {
      feishu: explicit.feishu ?? inferred?.feishu,
      discord: explicit.discord ?? inferred?.discord,
    };
  }

  if (wantsNotify) {
    return inferred;
  }

  return undefined;
}

function normalizeExplicitNotify(input: CronJobInput['notify']): NotifyTarget | undefined {
  if (!input) {
    return undefined;
  }

  const feishu = input.feishu?.receiveId
    ? {
        receiveId: input.feishu.receiveId,
        receiveIdType: input.feishu.receiveIdType ?? 'open_id',
      }
    : undefined;

  const discord = input.discord?.channelId
    ? {
        channelId: input.discord.channelId,
        isThread: input.discord.isThread ?? false,
      }
    : undefined;

  if (!feishu && !discord) {
    return undefined;
  }

  return { feishu, discord };
}

function isNotifyRequested(prompt?: string): boolean {
  if (!prompt) {
    return false;
  }

  const normalized = prompt.toLowerCase();
  return /\b(notify|notification|push|send|deliver)\b/.test(normalized)
    || /\b(feishu|lark|discord)\b/.test(normalized)
    || normalized.includes('通知')
    || normalized.includes('推送')
    || normalized.includes('发送');
}

function inferNotifyFromPlatformKey(platformKey: string): NotifyTarget | undefined {
  const feishuGroup = /^feishu:group:([^:]+):[^:]+$/.exec(platformKey);
  if (feishuGroup) {
    return {
      feishu: {
        receiveId: feishuGroup[1],
        receiveIdType: 'chat_id',
      },
    };
  }

  const feishuDm = /^feishu:([^:]+)$/.exec(platformKey);
  if (feishuDm) {
    return {
      feishu: {
        receiveId: feishuDm[1],
        receiveIdType: 'open_id',
      },
    };
  }

  const discordThread = /^discord:thread:([^:]+)$/.exec(platformKey);
  if (discordThread) {
    return {
      discord: {
        channelId: discordThread[1],
        isThread: true,
      },
    };
  }

  const discordChannel = /^discord:channel:([^:]+):[^:]+$/.exec(platformKey);
  if (discordChannel) {
    return {
      discord: {
        channelId: discordChannel[1],
        isThread: false,
      },
    };
  }

  return undefined;
}

async function sendSetupNotification(input: {
  notify?: NotifyTarget;
  jobSlug: string;
  schedule: string;
  timezone?: string;
}): Promise<void> {
  const notify = input.notify;
  if (!notify) {
    return;
  }

  const tzLabel = input.timezone ? ` (${input.timezone})` : '';
  const text = `Cron job scheduled: ${input.jobSlug}\nSchedule: ${input.schedule}${tzLabel}`;

  if (notify.feishu) {
    const client = createLarkClient();
    await sendTextMessage(client, notify.feishu.receiveId, notify.feishu.receiveIdType, text).catch((err) => {
      console.error('[cron_job] Failed to send Feishu setup notice:', err);
    });
  }

  if (notify.discord) {
    const client = new DiscordClient();
    await client
      .sendChannelMessage(notify.discord.channelId, text, { assumeThread: notify.discord.isThread })
      .catch((err) => {
        console.error('[cron_job] Failed to send Discord setup notice:', err);
      });
  }
}

function buildRunnerScript(input: {
  appDir: string;
  requestUrl: string;
  lockPath: string;
  prompt: string;
  skill?: string;
  platformKey: string;
  askPolicy: AskPolicy;
  forceNewSession: boolean;
  notify?: NotifyTarget;
}): string {
  const prompt = oneLine(input.prompt);
  const payload = {
    platformKey: input.platformKey,
    prompt,
    skill: input.skill,
    askPolicy: input.askPolicy,
    forceNewSession: input.forceNewSession,
    notify: input.notify,
  };

  const jsonPayload = JSON.stringify(payload);

  return `#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${input.appDir}"
LOCK_FILE="${input.lockPath}"

if [[ -f "${input.appDir}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${input.appDir}/.env"
  set +a
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required but not installed" >&2
  exit 1
fi

exec 200>"${input.lockPath}"
if ! flock -n 200; then
  echo "skip: previous run still active"
  exit 0
fi

if [[ -z "\${INTERNAL_API_SECRET:-}" ]]; then
  echo "INTERNAL_API_SECRET is not set" >&2
  exit 1
fi

PAYLOAD='${escapeSingleQuotes(jsonPayload)}'

curl -sS -X POST "${input.requestUrl}" \
  -H "Authorization: Bearer \${INTERNAL_API_SECRET}" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD"
`;
}

function buildCronBlock(input: {
  jobSlug: string;
  schedule: string;
  scriptPath: string;
  logPath: string;
  timezone?: string;
}): string {
  const lines = [
    `${CRON_BEGIN_PREFIX}${input.jobSlug}`,
  ];

  if (input.timezone) {
    lines.push(`CRON_TZ=${input.timezone}`);
  }

  lines.push(`${input.schedule} ${input.scriptPath} >> ${input.logPath} 2>&1`);
  lines.push(`${CRON_END_PREFIX}${input.jobSlug}`);

  return lines.join('\n');
}

function upsertCronBlock(existing: string, jobSlug: string, block: string): string {
  const begin = `${CRON_BEGIN_PREFIX}${jobSlug}`;
  const end = `${CRON_END_PREFIX}${jobSlug}`;
  const lines = existing.split('\n');

  let startIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === begin) {
      startIndex = i;
      continue;
    }
    if (lines[i].trim() === end) {
      endIndex = i;
      if (startIndex !== -1) {
        break;
      }
    }
  }

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    lines.splice(startIndex, endIndex - startIndex + 1, ...block.split('\n'));
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(...block.split('\n'));
  }

  return normalizeCron(lines.join('\n'));
}

function normalizeCron(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout ?? '';
  } catch (err: any) {
    const stderr = String(err?.stderr || '').toLowerCase();
    if (stderr.includes('no crontab')) {
      return '';
    }
    throw err;
  }
}

async function writeCrontab(content: string): Promise<void> {
  await execFileWithInput('crontab', ['-'], content);
}

async function validateScript(scriptPath: string): Promise<boolean> {
  try {
    await execFileAsync('bash', ['-n', scriptPath]);
    return true;
  } catch {
    return false;
  }
}

async function verifyCronBlock(jobSlug: string): Promise<boolean> {
  const content = await readCrontab();
  return content.includes(`${CRON_BEGIN_PREFIX}${jobSlug}`);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function execFileWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    if (!child.stdin) {
      reject(new Error('stdin is not available for execFile'));
      return;
    }

    child.stdin.write(input);
    child.stdin.end();
  });
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeSed(jobSlug: string, prefix: string): string {
  return `${prefix}${jobSlug}`.replace(/\//g, '\\/');
}

export default cronJobTool;

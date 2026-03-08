import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { IncomingMessage } from './types.js';
import type { CommandResult } from './chat-commands.js';

interface RestartNotifyTarget {
  platform: 'discord' | 'telegram' | 'feishu';
  channelId?: string;
  isThread?: boolean;
  userId?: string;
  chatId?: number;
  receiveId?: string;
  receiveIdType?: 'open_id' | 'chat_id';
}

interface RestartRecord {
  id: string;
  requestedAt: number;
  requestedBy: string;
  sourcePlatformKey: string;
  processName: string;
  status: 'scheduled' | 'ok' | 'error';
  notifyTarget?: RestartNotifyTarget;
  notifyStatus?: 'sent' | 'skipped' | 'error';
  notifyError?: string;
  completedAt?: number;
  detail?: string;
}

interface RestartCheckResult {
  ok: boolean;
  record?: RestartRecord;
  reason?: string;
}

const RESTART_RECORD_FILE = resolve(process.cwd(), '.restart-command-status.json');

export function handlePm2RestartCommand(incoming: IncomingMessage, args: string[]): CommandResult {
  if (!isPm2RestartAllowed(incoming)) {
    return {
      type: 'handled',
      message: '⛔ 当前身份未被授权执行 `/restart`。可通过环境变量 `RESTART_COMMAND_ALLOWLIST` 配置允许的 platformKey 或 memoryKey。',
    };
  }

  const sub = args[0]?.toLowerCase();
  if (sub === 'status' || sub === 'result') {
    return renderPm2RestartStatus();
  }

  if (args.length > 0) {
    return {
      type: 'handled',
      message: '❌ 用法：/restart 或 /restart status',
    };
  }

  const processName = process.env.PM2_PROCESS_NAME?.trim() || 'remote-server';
  const delayMs = getPm2RestartDelayMs();
  const notifyTarget = resolveRestartNotifyTarget(incoming.platformKey);
  const restartRecord: RestartRecord = {
    id: buildRestartRecordId(),
    requestedAt: Date.now(),
    requestedBy: incoming.memoryKey ?? incoming.platformKey,
    sourcePlatformKey: incoming.platformKey,
    processName,
    status: 'scheduled',
    notifyTarget,
  };

  const saveResult = saveRestartRecord(restartRecord);
  if (!saveResult.ok) {
    return {
      type: 'handled',
      message: `❌ 无法写入重启状态：${saveResult.reason ?? 'unknown error'}`,
    };
  }

  try {
    setTimeout(() => {
      try {
        const child = spawn(process.execPath, ['-e', buildPm2RestartWorkerScript(), RESTART_RECORD_FILE, restartRecord.id, processName], {
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', (error) => {
          markRestartRecordError(restartRecord.id, `spawn restart worker failed: ${String(error)}`);
          console.error(`[command] failed to spawn restart worker for ${processName}:`, error);
        });
        child.unref();
      } catch (error) {
        markRestartRecordError(restartRecord.id, `spawn restart worker failed: ${String(error)}`);
        console.error(`[command] failed to schedule restart worker for ${processName}:`, error);
      }
    }, delayMs);
  } catch (error) {
    markRestartRecordError(restartRecord.id, `schedule restart timer failed: ${String(error)}`);
    return {
      type: 'handled',
      message: `❌ 调度 pm2 重启失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const delaySeconds = (delayMs / 1000).toFixed(delayMs % 1000 === 0 ? 0 : 1);
  return {
    type: 'handled',
    message: [
      `♻️ 已接收重启请求，将在约 ${delaySeconds}s 后执行：\`pm2 restart ${processName} --update-env\``,
      `- 重启任务 ID: ${restartRecord.id}`,
      '- 可在服务恢复后使用 `/restart status` 查看成功或失败结果。',
    ].join('\n'),
  };
}

function renderPm2RestartStatus(): CommandResult {
  const result = readRestartRecord();
  if (!result.ok) {
    return {
      type: 'handled',
      message: `⚠️ 读取重启状态失败：${result.reason ?? 'unknown error'}`,
    };
  }

  if (!result.record) {
    return {
      type: 'handled',
      message: 'ℹ️ 暂无重启记录。先执行一次 `/restart`。',
    };
  }

  const record = result.record;
  const statusText = record.status === 'scheduled'
    ? '排队中'
    : record.status === 'ok'
      ? '成功'
      : '失败';

  const lines = [
    '♻️ 最近重启状态：',
    `- 任务 ID: ${record.id}`,
    `- 进程: ${record.processName}`,
    `- 状态: ${statusText}`,
    `- 请求时间: ${formatTime(record.requestedAt)}`,
  ];

  if (record.completedAt) {
    lines.push(`- 完成时间: ${formatTime(record.completedAt)}`);
  }

  if (record.detail) {
    lines.push(`- 详情: ${record.detail}`);
  }

  if (record.notifyStatus) {
    lines.push(`- 通知: ${record.notifyStatus}`);
  }

  if (record.notifyError) {
    lines.push(`- 通知错误: ${record.notifyError}`);
  }

  return {
    type: 'handled',
    message: lines.join('\n'),
  };
}

function buildRestartRecordId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

function readRestartRecord(): RestartCheckResult {
  try {
    const raw = readFileSync(RESTART_RECORD_FILE, 'utf8').trim();
    if (!raw) {
      return { ok: true };
    }

    const parsed = JSON.parse(raw) as RestartRecord;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
      return { ok: false, reason: 'invalid record format' };
    }

    return { ok: true, record: parsed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: true };
    }

    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function saveRestartRecord(record: RestartRecord): { ok: true } | { ok: false; reason: string } {
  try {
    writeFileSync(RESTART_RECORD_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function markRestartRecordError(recordId: string, detail: string): void {
  const result = readRestartRecord();
  if (!result.ok || !result.record || result.record.id !== recordId) {
    return;
  }

  const updated: RestartRecord = {
    ...result.record,
    status: 'error',
    completedAt: Date.now(),
    detail: detail.slice(0, 800),
  };
  const saveResult = saveRestartRecord(updated);
  if (!saveResult.ok) {
    console.error('[command] failed to persist restart error status:', saveResult.reason);
  }
}

function buildPm2RestartWorkerScript(): string {
  return [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const filePath = process.argv[1];',
    'const restartId = process.argv[2];',
    'const processName = process.argv[3];',
    'if (!filePath || !restartId || !processName) process.exit(0);',
    'const truncate = (value, max) => String(value || "").slice(0, max);',
    'const loadRecord = () => {',
    '  try {',
    "    const raw = readFileSync(filePath, 'utf8').trim();",
    '    return raw ? JSON.parse(raw) : null;',
    '  } catch {',
    '    return null;',
    '  }',
    '};',
    'const saveRecord = (record) => {',
    '  try {',
    "    writeFileSync(filePath, `${JSON.stringify(record)}\\n`, 'utf8');",
    '  } catch {}',
    '};',
    'const sendDiscord = async (target, message) => {',
    '  const token = process.env.DISCORD_BOT_TOKEN;',
    '  if (!token) return { ok: false, reason: "DISCORD_BOT_TOKEN is not set" };',
    '  const baseUrl = (process.env.DISCORD_API_BASE_URL || "https://discord.com/api/v10").replace(/\\/$/, "");',
    '  const headers = { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "PulseRestartWorker/1.0" };',
    '  const sendToChannel = async (channelId) => {',
    '    const resp = await fetch(`${baseUrl}/channels/${encodeURIComponent(channelId)}/messages`, {',
    '      method: "POST",',
    '      headers,',
    '      body: JSON.stringify({ content: String(message).slice(0, 1900) }),',
    '    });',
    '    if (!resp.ok) {',
    '      const body = await resp.text();',
    '      throw new Error(`discord send failed: ${resp.status} ${body}`);',
    '    }',
    '  };',
    '  try {',
    '    if (target.channelId) {',
    '      await sendToChannel(target.channelId);',
    '      return { ok: true };',
    '    }',
    '    if (target.userId) {',
    '      const dmResp = await fetch(`${baseUrl}/users/@me/channels`, {',
    '        method: "POST",',
    '        headers,',
    '        body: JSON.stringify({ recipient_id: target.userId }),',
    '      });',
    '      if (!dmResp.ok) {',
    '        const body = await dmResp.text();',
    '        throw new Error(`discord create dm failed: ${dmResp.status} ${body}`);',
    '      }',
    '      const dm = await dmResp.json();',
    '      const dmChannelId = dm && typeof dm.id === "string" ? dm.id : "";',
    '      if (!dmChannelId) throw new Error("discord create dm missing channel id");',
    '      await sendToChannel(dmChannelId);',
    '      return { ok: true };',
    '    }',
    '    return { ok: false, reason: "missing-discord-target" };',
    '  } catch (error) {',
    '    return { ok: false, reason: error instanceof Error ? error.message : String(error) };',
    '  }',
    '};',
    'const sendTelegram = async (target, message) => {',
    '  const token = process.env.TELEGRAM_BOT_TOKEN;',
    '  if (!token) return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set" };',
    '  if (!Number.isFinite(target.chatId)) return { ok: false, reason: "missing-telegram-chat-id" };',
    '  try {',
    '    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {',
    '      method: "POST",',
    '      headers: { "content-type": "application/json" },',
    '      body: JSON.stringify({ chat_id: target.chatId, text: String(message).slice(0, 3500) }),',
    '    });',
    '    const body = await resp.json().catch(() => null);',
    '    if (!resp.ok || !body || body.ok !== true) {',
    '      throw new Error(`telegram send failed: ${resp.status} ${JSON.stringify(body)}`);',
    '    }',
    '    return { ok: true };',
    '  } catch (error) {',
    '    return { ok: false, reason: error instanceof Error ? error.message : String(error) };',
    '  }',
    '};',
    'const sendFeishu = async (target, message) => {',
    '  if (!target.receiveId || !target.receiveIdType) return { ok: false, reason: "missing-feishu-target" };',
    '  const appId = process.env.FEISHU_APP_ID;',
    '  const appSecret = process.env.FEISHU_APP_SECRET;',
    '  if (!appId || !appSecret) return { ok: false, reason: "FEISHU_APP_ID or FEISHU_APP_SECRET is not set" };',
    '  const baseUrl = (process.env.FEISHU_API_BASE_URL || "https://open.feishu.cn").replace(/\\/$/, "");',
    '  try {',
    '    const tokenResp = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {',
    '      method: "POST",',
    '      headers: { "content-type": "application/json" },',
    '      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),',
    '    });',
    '    const tokenPayload = await tokenResp.json().catch(() => null);',
    '    const token = tokenPayload && typeof tokenPayload.tenant_access_token === "string" ? tokenPayload.tenant_access_token : "";',
    '    if (!tokenResp.ok || !token) {',
    '      throw new Error(`feishu token failed: ${tokenResp.status} ${JSON.stringify(tokenPayload)}`);',
    '    }',
    '    const msgResp = await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`, {',
    '      method: "POST",',
    '      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },',
    '      body: JSON.stringify({',
    '        receive_id: target.receiveId,',
    '        msg_type: "text",',
    '        content: JSON.stringify({ text: String(message).slice(0, 2800) }),',
    '      }),',
    '    });',
    '    const msgPayload = await msgResp.json().catch(() => null);',
    '    if (!msgResp.ok || !msgPayload || msgPayload.code !== 0) {',
    '      throw new Error(`feishu send failed: ${msgResp.status} ${JSON.stringify(msgPayload)}`);',
    '    }',
    '    return { ok: true };',
    '  } catch (error) {',
    '    return { ok: false, reason: error instanceof Error ? error.message : String(error) };',
    '  }',
    '};',
    'const sendNotification = async (record) => {',
    '  const target = record.notifyTarget;',
    '  if (!target || !target.platform) return { ok: false, reason: "no-notify-target" };',
    '  const statusText = record.status === "ok" ? "成功" : "失败";',
    '  const lines = [',
    '    `♻️ /restart 执行${statusText}` ,',
    '    `- 任务 ID: ${record.id}` ,',
    '    `- 进程: ${record.processName}` ,',
    '    `- 请求时间: ${new Date(record.requestedAt).toLocaleString()}` ,',
    '    `- 完成时间: ${new Date(record.completedAt || Date.now()).toLocaleString()}` ,',
    '  ];',
    '  if (record.detail) lines.push(`- 详情: ${record.detail}`);',
    '  const message = lines.join("\\n");',
    '  if (target.platform === "discord") return sendDiscord(target, message);',
    '  if (target.platform === "telegram") return sendTelegram(target, message);',
    '  if (target.platform === "feishu") return sendFeishu(target, message);',
    '  return { ok: false, reason: "unsupported-platform" };',
    '};',
    '(async () => {',
    '  const record = loadRecord();',
    '  if (!record || record.id !== restartId) process.exit(0);',
    "  const result = spawnSync('pm2', ['restart', processName, '--update-env'], { encoding: 'utf8' });",
    '  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();',
    '  record.completedAt = Date.now();',
    '  record.status = result.status === 0 ? "ok" : "error";',
    '  record.detail = truncate(output, 1200);',
    '  const notifyResult = await sendNotification(record);',
    '  if (notifyResult.ok) {',
    '    record.notifyStatus = "sent";',
    '    record.notifyError = undefined;',
    '  } else {',
    '    record.notifyStatus = notifyResult.reason === "no-notify-target" ? "skipped" : "error";',
    '    record.notifyError = truncate(notifyResult.reason || "notify failed", 500);',
    '  }',
    '  saveRecord(record);',
    '})().catch((error) => {',
    '  const record = loadRecord();',
    '  if (record && record.id === restartId) {',
    '    record.completedAt = Date.now();',
    '    record.status = "error";',
    '    record.detail = truncate(error instanceof Error ? error.message : String(error), 1200);',
    '    record.notifyStatus = "error";',
    '    record.notifyError = "restart worker exception";',
    '    saveRecord(record);',
    '  }',
    '});',
  ].join('\n');
}

function resolveRestartNotifyTarget(platformKey: string): RestartNotifyTarget | undefined {
  const threadMatch = /^discord:thread:([^:]+)$/.exec(platformKey);
  if (threadMatch) {
    return {
      platform: 'discord',
      channelId: threadMatch[1],
      isThread: true,
    };
  }

  const channelMatch = /^discord:channel:([^:]+):([^:]+)$/.exec(platformKey);
  if (channelMatch) {
    return {
      platform: 'discord',
      channelId: channelMatch[1],
      isThread: false,
      userId: channelMatch[2],
    };
  }

  const userMatch = /^discord:([^:]+)$/.exec(platformKey);
  if (userMatch) {
    return {
      platform: 'discord',
      userId: userMatch[1],
    };
  }

  const telegramMatch = /^telegram:(\-?\d+)$/.exec(platformKey);
  if (telegramMatch) {
    const chatId = Number.parseInt(telegramMatch[1], 10);
    if (Number.isFinite(chatId)) {
      return {
        platform: 'telegram',
        chatId,
      };
    }
  }

  const feishuGroupMatch = /^feishu:group:([^:]+):[^:]+$/.exec(platformKey);
  if (feishuGroupMatch) {
    return {
      platform: 'feishu',
      receiveId: feishuGroupMatch[1],
      receiveIdType: 'chat_id',
    };
  }

  const feishuUserMatch = /^feishu:([^:]+)$/.exec(platformKey);
  if (feishuUserMatch) {
    return {
      platform: 'feishu',
      receiveId: feishuUserMatch[1],
      receiveIdType: 'open_id',
    };
  }

  return undefined;
}

function isPm2RestartAllowed(incoming: IncomingMessage): boolean {
  const rawAllowlist = process.env.RESTART_COMMAND_ALLOWLIST?.trim();
  if (!rawAllowlist) {
    return true;
  }

  const allowedKeys = new Set(rawAllowlist.split(',').map((value) => value.trim()).filter((value) => value.length > 0));
  const memoryKey = incoming.memoryKey ?? incoming.platformKey;
  return allowedKeys.has(incoming.platformKey) || allowedKeys.has(memoryKey);
}

function getPm2RestartDelayMs(): number {
  const raw = process.env.PM2_RESTART_DELAY_MS?.trim();
  if (!raw) {
    return 1200;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1200;
  }

  return parsed;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

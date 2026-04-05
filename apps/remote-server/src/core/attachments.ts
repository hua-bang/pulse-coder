import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, extname, join } from 'path';
import { fetch } from 'undici';
import { getDiscordProxyDispatcher } from '../adapters/discord/proxy.js';
import type { IncomingAttachment } from './types.js';
import { vaultIntegration, buildRemoteVaultRunContext } from './vault/integration.js';

export interface StoredAttachment {
  id: string;
  path: string;
  mimeType?: string;
  name?: string;
  size?: number;
  source?: string;
  messageId?: string;
  createdAt: number;
  originalUrl?: string;
}

export interface ResolveAttachmentsResult {
  attachments: StoredAttachment[];
  errors: string[];
  hadImageAttachments: boolean;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 6;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_FALLBACK_DIR = join(homedir(), '.pulse-coder', 'remote-attachments');

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
]);

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

export async function resolveIncomingAttachments(input: {
  platformKey: string;
  ownerKey?: string;
  attachments?: IncomingAttachment[];
}): Promise<ResolveAttachmentsResult> {
  const incoming = input.attachments ?? [];
  const maxCount = readEnvInt('ATTACHMENT_MAX_COUNT', DEFAULT_MAX_COUNT);

  if (incoming.length === 0) {
    return { attachments: [], errors: [], hadImageAttachments: false };
  }

  const candidates = incoming.filter((attachment) => isImageAttachment(attachment)).slice(0, maxCount);
  const errors: string[] = [];
  const hadImageAttachments = candidates.length > 0;

  if (candidates.length === 0) {
    return { attachments: [], errors, hadImageAttachments };
  }

  const targetDir = await resolveAttachmentDirectory(input.platformKey, input.ownerKey);
  await fs.mkdir(targetDir, { recursive: true });

  const results: StoredAttachment[] = [];
  for (const attachment of candidates) {
    try {
      const stored = await downloadAttachment(attachment, targetDir);
      if (stored) {
        results.push(stored);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
    }
  }

  return { attachments: results, errors, hadImageAttachments };
}

export function hasIncomingImageAttachments(attachments?: IncomingAttachment[]): boolean {
  return (attachments ?? []).some((attachment) => isImageAttachment(attachment));
}

export function buildAttachmentSystemPrompt(attachments: StoredAttachment[]): string | null {
  if (!attachments.length) {
    return null;
  }

  const lines = [
    'Latest attachments available:',
    ...attachments.map((attachment, index) => {
      const sizeLabel = attachment.size ? `${Math.round(attachment.size / 1024)}KB` : 'unknown';
      const nameLabel = attachment.name ? ` name=${attachment.name}` : '';
      const mimeLabel = attachment.mimeType ? ` mime=${attachment.mimeType}` : '';
      return `- [${index + 1}] id=${attachment.id}${nameLabel}${mimeLabel} size=${sizeLabel}`;
    }),
    'Use tool analyze_image without imagePaths to analyze the latest attachments by default.',
  ];

  return lines.join('\n');
}

async function resolveAttachmentDirectory(platformKey: string, ownerKey?: string): Promise<string> {
  const vault = await vaultIntegration.getVault({
    runContext: buildRemoteVaultRunContext(platformKey),
    engineRunContext: { platformKey, ownerKey },
  });

  const baseDir = vault?.artifactsPath ?? DEFAULT_FALLBACK_DIR;
  return join(baseDir, 'attachments', sanitizeSegment(platformKey));
}

async function downloadAttachment(attachment: IncomingAttachment, targetDir: string): Promise<StoredAttachment | null> {
  const timeoutMs = readEnvInt('ATTACHMENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const maxBytes = readEnvInt('ATTACHMENT_MAX_BYTES', DEFAULT_MAX_BYTES);

  const url = attachment.url.trim();
  if (!url) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      dispatcher: resolveAttachmentDispatcher(attachment),
      headers: {
        'User-Agent': 'pulse-remote-server',
      },
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch attachment: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Attachment download failed (${response.status} ${response.statusText}): ${body}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Attachment exceeds size limit (${contentLength} > ${maxBytes})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Attachment exceeds size limit (${buffer.length} > ${maxBytes})`);
  }

  const resolvedMime = normalizeMimeType(attachment.mimeType || response.headers.get('content-type'));
  const extension = resolveExtension(attachment.name, resolvedMime, url);
  const displayName = attachment.name ? sanitizeFileName(attachment.name) : undefined;
  const fileNameBase = displayName || `${attachment.id ?? randomUUID()}${extension}`;
  const fileName = `${Date.now()}-${fileNameBase}`;
  const outputPath = join(targetDir, fileName);

  await fs.writeFile(outputPath, buffer);

  return {
    id: attachment.id ?? randomUUID(),
    path: outputPath,
    mimeType: resolvedMime ?? undefined,
    name: displayName ?? basename(outputPath),
    size: buffer.length,
    source: attachment.source,
    messageId: attachment.messageId,
    createdAt: Date.now(),
    originalUrl: attachment.url,
  };
}

export function resolveAttachmentDispatcher(attachment: IncomingAttachment) {
  if (attachment.source !== 'discord') {
    return undefined;
  }
  return getDiscordProxyDispatcher();
}

export function isImageAttachment(attachment: IncomingAttachment): boolean {
  if (attachment.mimeType && attachment.mimeType.startsWith('image/')) {
    return true;
  }

  const extension = resolveExtension(attachment.name, attachment.mimeType, attachment.url);
  return IMAGE_EXTENSIONS.has(extension);
}

function resolveExtension(name?: string, mimeType?: string | null, url?: string): string {
  const fromName = name ? extname(name).toLowerCase() : '';
  if (fromName) {
    return fromName;
  }

  const fromUrl = url ? extname(url.split('?')[0]).toLowerCase() : '';
  if (fromUrl) {
    return fromUrl;
  }

  const normalizedMime = normalizeMimeType(mimeType);
  if (normalizedMime && MIME_EXTENSION_MAP[normalizedMime]) {
    return MIME_EXTENSION_MAP[normalizedMime];
  }

  return '';
}

function normalizeMimeType(mimeType?: string | null): string | null {
  if (!mimeType) {
    return null;
  }
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase();
  return normalized || null;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sanitizeFileName(name: string): string {
  const base = basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

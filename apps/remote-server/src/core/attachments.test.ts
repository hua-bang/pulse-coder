import { afterEach, describe, expect, it } from 'vitest';

import { getDiscordProxyDispatcher } from '../adapters/discord/proxy.js';
import {
  buildAttachmentSystemPrompt,
  hasIncomingImageAttachments,
  isImageAttachment,
  resolveAttachmentDispatcher,
  resolveIncomingAttachments,
} from './attachments.js';

describe('attachment helpers', () => {
  const originalDiscordProxyUrl = process.env.DISCORD_PROXY_URL;

  afterEach(() => {
    if (originalDiscordProxyUrl === undefined) {
      delete process.env.DISCORD_PROXY_URL;
      return;
    }
    process.env.DISCORD_PROXY_URL = originalDiscordProxyUrl;
  });

  it('detects image attachments by mime type and filename', () => {
    expect(isImageAttachment({ url: 'https://example.com/file', mimeType: 'image/png' })).toBe(true);
    expect(isImageAttachment({ url: 'https://example.com/file.JPG', name: 'photo.JPG' })).toBe(true);
    expect(isImageAttachment({ url: 'https://example.com/file.pdf', name: 'file.pdf', mimeType: 'application/pdf' })).toBe(false);
  });

  it('reports whether an incoming message contains any image attachments', () => {
    expect(hasIncomingImageAttachments()).toBe(false);
    expect(hasIncomingImageAttachments([{ url: 'https://example.com/file.pdf', name: 'file.pdf', mimeType: 'application/pdf' }])).toBe(false);
    expect(hasIncomingImageAttachments([{ url: 'https://example.com/file.png', name: 'file.png' }])).toBe(true);
  });

  it('routes discord attachment downloads through the discord proxy dispatcher', () => {
    process.env.DISCORD_PROXY_URL = 'http://127.0.0.1:8080';

    expect(resolveAttachmentDispatcher({ url: 'https://cdn.discordapp.com/image.png', source: 'discord' })).toBe(getDiscordProxyDispatcher());
    expect(resolveAttachmentDispatcher({ url: 'https://example.com/image.png', source: 'web' })).toBeUndefined();
  });

  it('does not treat non-image attachments as latest image attachments', async () => {
    const result = await resolveIncomingAttachments({
      platformKey: 'discord:thread:test',
      attachments: [
        {
          url: 'https://example.com/report.pdf',
          name: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });

    expect(result.hadImageAttachments).toBe(false);
    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('builds a system prompt for the latest attachments', () => {
    const prompt = buildAttachmentSystemPrompt([
      {
        id: 'att-1',
        path: '/tmp/photo.png',
        name: 'photo.png',
        mimeType: 'image/png',
        size: 2048,
        createdAt: 1,
      },
    ]);

    expect(prompt).toContain('Latest attachments available:');
    expect(prompt).toContain('name=photo.png');
    expect(prompt).toContain('Use tool analyze_image without imagePaths');
  });
});

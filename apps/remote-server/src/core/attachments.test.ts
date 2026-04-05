import { describe, expect, it } from 'vitest';

import { buildAttachmentSystemPrompt, hasIncomingImageAttachments, isImageAttachment, resolveIncomingAttachments } from './attachments.js';

describe('attachment helpers', () => {
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

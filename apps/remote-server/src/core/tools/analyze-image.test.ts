import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mockFetch,
  Agent: vi.fn(),
}));

import { analyzeImageTool } from './analyze-image.js';

describe('analyzeImageTool', () => {
  let tempDir: string;
  let attachmentPath: string;
  let explicitPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'analyze-image-tool-'));
    attachmentPath = join(tempDir, 'attachment.png');
    explicitPath = join(tempDir, 'explicit.jpg');
    await writeFile(attachmentPath, 'attachment-image');
    await writeFile(explicitPath, 'explicit-image');
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_API_URL = 'http://localhost:18080';
    delete process.env.GEMINI_API_KEY;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'analysis result' }],
          },
        ],
      }),
    });
  });

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_URL;
    delete process.env.GEMINI_API_KEY;
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('uses runContext latestAttachments when imagePaths are omitted', async () => {
    const result = await analyzeImageTool.execute(
      { prompt: 'describe it' },
      {
        runContext: {
          latestAttachments: [
            {
              id: 'att-1',
              path: attachmentPath,
              mimeType: 'image/png',
              createdAt: Date.now(),
            },
          ],
        },
      },
    );

    expect(result.source).toBe('runContext.latestAttachments');
    expect(result.imagePaths).toEqual([attachmentPath]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const requestUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(requestUrl).toBe('http://localhost:18080/responses');

    const request = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.input[0].content[0].text).toBe('describe it');
    expect(body.input[0].content[1].type).toBe('input_image');
    expect(body.input[0].content[1].image_url).toContain('data:image/png;base64,');
  });

  it('prefers explicit imagePaths over runContext attachments', async () => {
    const result = await analyzeImageTool.execute(
      { imagePaths: [explicitPath] },
      {
        runContext: {
          latestAttachments: [
            {
              id: 'att-1',
              path: attachmentPath,
              mimeType: 'image/png',
              createdAt: Date.now(),
            },
          ],
        },
      },
    );

    expect(result.source).toBe('input.imagePaths');
    expect(result.imagePaths).toEqual([explicitPath]);

    const request = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.input[0].content[1].image_url).toContain('data:image/jpeg;base64,');
  });

  it('throws when neither imagePaths nor latestAttachments are available', async () => {
    await expect(analyzeImageTool.execute({}, { runContext: {} })).rejects.toThrow(
      'No images available. Provide imagePaths or upload images so runContext.latestAttachments is populated.',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses a fixed 5 minute timeout even when timeoutMs is provided', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await analyzeImageTool.execute(
      { prompt: 'describe it', timeoutMs: 60000 },
      {
        runContext: {
          latestAttachments: [
            {
              id: 'att-1',
              path: attachmentPath,
              mimeType: 'image/png',
              createdAt: Date.now(),
            },
          ],
        },
      },
    );

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 300000);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 60000);
  });

  it('configures loopback requests with a 5 minute headers timeout', () => {
    expect(vi.mocked(Agent)).toHaveBeenCalledWith(expect.objectContaining({
      headersTimeout: 300000,
      bodyTimeout: 0,
    }));
  });
});

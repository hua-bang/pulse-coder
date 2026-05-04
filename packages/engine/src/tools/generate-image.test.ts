import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock('undici', () => ({
  Agent: vi.fn(),
}));

describe('GenerateImageTool', () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE_URL;
    delete process.env.OPENAI_IMAGE_MODEL;
    delete process.env.OPENAI_IMAGE_RESPONSES_MODEL;
    delete process.env.OPENAI_RESPONSES_MODEL;
    delete process.env.OPENAI_IMAGE_API_MODE;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses OPENAI_API_URL for responses image generation', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_API_URL = 'http://localhost:18080';
    process.env.OPENAI_BASE_URL = 'http://localhost:8080';
    process.env.OPENAI_API_BASE_URL = 'http://localhost:28080';
    tempDir = await mkdtemp(join(tmpdir(), 'generate-image-tool-'));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        output: [
          {
            type: 'image_generation_call',
            result: Buffer.from('fake-image').toString('base64'),
          },
        ],
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { GenerateImageTool } = await import('./generate-image.js');
    const result = await GenerateImageTool.execute({
      prompt: 'draw a cat',
      outputPath: join(tempDir, 'cat.png'),
      imageApiMode: 'responses',
    });

    expect(result.outputPath).toBe(join(tempDir, 'cat.png'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe('http://localhost:18080/responses');
  });

  it('configures loopback requests with a 5 minute headers timeout', async () => {
    await import('./generate-image.js');

    const { Agent } = await import('undici');
    expect(vi.mocked(Agent)).toHaveBeenCalledWith(expect.objectContaining({
      headersTimeout: 300000,
      bodyTimeout: 0,
    }));
  });
});

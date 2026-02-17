import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Context, Tool } from '../shared/types.js';

const { streamTextAIMock, maybeCompactContextMock } = vi.hoisted(() => ({
  streamTextAIMock: vi.fn(),
  maybeCompactContextMock: vi.fn(),
}));

vi.mock('../ai', () => ({
  streamTextAI: streamTextAIMock,
}));

vi.mock('../context', () => ({
  maybeCompactContext: maybeCompactContextMock,
}));

import { loop } from './loop.js';

describe('loop', () => {
  beforeEach(() => {
    streamTextAIMock.mockReset();
    maybeCompactContextMock.mockReset();
    maybeCompactContextMock.mockResolvedValue({ didCompact: false });
    vi.useRealTimers();
  });

  it('applies llm/tool hooks and returns transformed tool output', async () => {
    const context: Context = {
      messages: [{ role: 'user', content: 'run tool' }],
    };

    const echoExecute = vi.fn(async (input: { value: string }) => `${input.value}-exec`);
    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: {} as any,
      execute: echoExecute,
    };

    const beforeLLMCall = vi.fn(async ({ systemPrompt, tools }: any) => ({
      systemPrompt: `${String(systemPrompt)}-hooked`,
      tools,
    }));

    const onResponse = vi.fn();

    streamTextAIMock.mockImplementation((_messages: any, tools: Record<string, Tool>, options: any) => {
      const text = (async () => {
        const output = await tools.echo.execute({ value: 'seed' }, options.toolExecutionContext);
        return `tool:${output}`;
      })();

      return {
        text,
        steps: Promise.resolve([
          {
            response: {
              messages: [{ role: 'assistant', content: 'step response' }],
            },
          },
        ]),
        finishReason: Promise.resolve('stop'),
      };
    });

    const result = await loop(context, {
      tools: {
        echo: echoTool,
      },
      systemPrompt: 'base-prompt',
      hooks: {
        beforeLLMCall: [beforeLLMCall],
        beforeToolCall: [async ({ input }) => ({ input: { value: `${input.value}-before` } })],
        afterToolCall: [async ({ output }) => ({ output: `${output}-after` })],
      },
      onResponse,
    });

    expect(result).toBe('tool:seed-before-exec-after');
    expect(beforeLLMCall).toHaveBeenCalledTimes(1);
    expect(streamTextAIMock).toHaveBeenCalledWith(
      context.messages,
      expect.objectContaining({ echo: expect.any(Object) }),
      expect.objectContaining({ systemPrompt: 'base-prompt-hooked' }),
    );
    expect(echoExecute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'seed-before' }),
      expect.anything(),
    );
    expect(onResponse).toHaveBeenCalledWith([{ role: 'assistant', content: 'step response' }]);
  });

  it('retries retryable errors with backoff and eventually succeeds', async () => {
    vi.useFakeTimers();

    const context: Context = {
      messages: [{ role: 'user', content: 'retry test' }],
    };

    const retryableError = Object.assign(new Error('rate limited'), { status: 429 });

    streamTextAIMock
      .mockImplementationOnce(() => {
        throw retryableError;
      })
      .mockImplementationOnce(() => ({
        text: Promise.resolve('retry-success'),
        steps: Promise.resolve([]),
        finishReason: Promise.resolve('stop'),
      }));

    const runPromise = loop(context);

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(runPromise).resolves.toBe('retry-success');
    expect(streamTextAIMock).toHaveBeenCalledTimes(2);
  });

  it('stops when tool-call steps reach max step limit', async () => {
    const context: Context = {
      messages: [{ role: 'user', content: 'step limit' }],
    };

    streamTextAIMock.mockReturnValue({
      text: Promise.resolve(''),
      steps: Promise.resolve(Array.from({ length: 100 }, () => ({ response: { messages: [] } }))),
      finishReason: Promise.resolve('tool-calls'),
    });

    const result = await loop(context);

    expect(result).toBe('Max steps reached, task may be incomplete.');
  });
});

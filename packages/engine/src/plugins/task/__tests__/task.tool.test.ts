import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskTool } from '../task.tool.js';

// Mock the loop module
vi.mock('../../../core/loop.js', () => ({
  loop: vi.fn(async () => 'Sub-agent completed the task successfully.'),
}));

import { loop } from '../../../core/loop.js';

describe('createTaskTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockTools = {
    read: { name: 'read', description: 'Read a file', inputSchema: {}, execute: vi.fn() },
    write: { name: 'write', description: 'Write a file', inputSchema: {}, execute: vi.fn() },
    bash: { name: 'bash', description: 'Run bash', inputSchema: {}, execute: vi.fn() },
    task: { name: 'task', description: 'Task tool', inputSchema: {}, execute: vi.fn() },
  };

  it('should create a tool with correct name and description', () => {
    const tool = createTaskTool({ getTools: () => mockTools as any });
    expect(tool.name).toBe('task');
    expect(tool.description).toContain('sub-agent');
  });

  it('should exclude the task tool itself from sub-agent tools', async () => {
    const tool = createTaskTool({ getTools: () => mockTools as any });

    await tool.execute({ description: 'Test task', prompt: 'Do something' });

    expect(loop).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(loop).mock.calls[0];
    const loopOptions = callArgs[1]!;
    const subTools = loopOptions.tools!;

    // task tool should be excluded
    expect(subTools).not.toHaveProperty('task');
    // other tools should be present
    expect(subTools).toHaveProperty('read');
    expect(subTools).toHaveProperty('write');
    expect(subTools).toHaveProperty('bash');
  });

  it('should create a fresh context with the prompt', async () => {
    const tool = createTaskTool({ getTools: () => mockTools as any });

    await tool.execute({ description: 'Search code', prompt: 'Find all usages of foo' });

    const callArgs = vi.mocked(loop).mock.calls[0];
    const context = callArgs[0];

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe('user');
    expect(context.messages[0].content).toContain('Search code');
    expect(context.messages[0].content).toContain('Find all usages of foo');
  });

  it('should return the loop result', async () => {
    const tool = createTaskTool({ getTools: () => mockTools as any });
    const result = await tool.execute({ description: 'Test', prompt: 'Do it' });
    expect(result).toEqual({ result: 'Sub-agent completed the task successfully.' });
  });

  it('should pass abort signal to sub-loop', async () => {
    const tool = createTaskTool({ getTools: () => mockTools as any });
    const ac = new AbortController();

    await tool.execute(
      { description: 'Test', prompt: 'Do it' },
      { abortSignal: ac.signal }
    );

    const callArgs = vi.mocked(loop).mock.calls[0];
    const loopOptions = callArgs[1]!;
    expect(loopOptions.abortSignal).toBe(ac.signal);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createJsExecutor } from './executor.js';
import { createRunJsTool } from './tool.js';

describe('createRunJsTool', () => {
  it('uses defaults and forwards execution to executor', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      result: 3,
      stdout: '',
      stderr: '',
      durationMs: 1,
      outputTruncated: false
    });

    const tool = createRunJsTool({
      executor: { execute }
    });

    expect(tool.name).toBe('run_js');
    expect(tool.description).toContain('Execute JavaScript');

    const payload = { code: 'return 1 + 2;' };
    const output = await tool.execute(payload);

    expect(execute).toHaveBeenCalledWith(payload);
    expect(output.ok).toBe(true);
  });
});

describe('createJsExecutor', () => {
  it('returns POLICY_BLOCKED for invalid timeout or empty code', async () => {
    const executor = createJsExecutor();

    const invalidTimeout = await executor.execute({ code: 'return 1;', timeoutMs: 0 });
    expect(invalidTimeout.ok).toBe(false);
    expect(invalidTimeout.error?.code).toBe('POLICY_BLOCKED');

    const emptyCode = await executor.execute({ code: '   ' });
    expect(emptyCode.ok).toBe(false);
    expect(emptyCode.error?.code).toBe('POLICY_BLOCKED');
  });
});

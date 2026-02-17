import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillCommands } from './skill-commands.js';

interface SkillSummary {
  name: string;
  description: string;
}

describe('SkillCommands', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transforms skill command to one-shot skill message by index', async () => {
    const skills: SkillSummary[] = [
      { name: 'zeta', description: 'z skill' },
      { name: 'alpha', description: 'a skill' },
    ];

    const registry = {
      getAll: vi.fn(() => skills),
      get: vi.fn(),
    };

    const agent = {
      getService: vi.fn(() => registry),
    } as any;

    const commands = new SkillCommands(agent);
    const transformed = await commands.transformSkillsCommandToMessage(['1', 'ship', 'it']);

    // Skills are sorted by name, so index 1 resolves to "alpha"
    expect(transformed).toBe('[use skill](alpha) ship it');
  });

  it('returns null when selected skill does not exist', async () => {
    const registry = {
      getAll: vi.fn(() => [{ name: 'refactor', description: 'refactor code' }]),
      get: vi.fn(),
    };

    const agent = {
      getService: vi.fn(() => registry),
    } as any;

    const commands = new SkillCommands(agent);
    const transformed = await commands.transformSkillsCommandToMessage(['missing', 'hello']);

    expect(transformed).toBeNull();
  });

  it('returns null when skill registry is unavailable', async () => {
    const agent = {
      getService: vi.fn(() => undefined),
    } as any;

    const commands = new SkillCommands(agent);
    const transformed = await commands.transformSkillsCommandToMessage(['list']);

    expect(transformed).toBeNull();
  });
});

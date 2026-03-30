import { describe, it, expect, vi } from 'vitest';
import { planTeam, buildTeammateOptionsFromPlan } from '../planner.js';
import type { TeamPlan } from '../planner.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('planTeam', () => {
  it('should parse a valid plan from LLM response', async () => {
    const mockPlan: TeamPlan = {
      teammates: [
        { name: 'researcher', role: 'Research the codebase', spawnPrompt: 'You are a researcher.' },
        { name: 'implementer', role: 'Implement changes', spawnPrompt: 'You are an implementer.' },
      ],
      tasks: [
        { title: 'Analyze codebase', description: 'Read and analyze the current structure', assignTo: 'researcher', depNames: [] },
        { title: 'Implement feature', description: 'Build the new feature', assignTo: 'implementer', depNames: ['Analyze codebase'] },
      ],
    };

    const plan = await planTeam('Build a new feature', {
      llmCall: async () => JSON.stringify(mockPlan),
      logger: silentLogger,
    });

    expect(plan.teammates).toHaveLength(2);
    expect(plan.teammates[0].name).toBe('researcher');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1].depNames).toEqual(['Analyze codebase']);
  });

  it('should handle LLM response with markdown fences', async () => {
    const mockPlan: TeamPlan = {
      teammates: [
        { name: 'analyst', role: 'Analyze', spawnPrompt: 'You are an analyst.' },
      ],
      tasks: [
        { title: 'Analyze', description: 'Analyze the task' },
      ],
    };

    const plan = await planTeam('Some task', {
      llmCall: async () => '```json\n' + JSON.stringify(mockPlan) + '\n```',
      logger: silentLogger,
    });

    expect(plan.teammates).toHaveLength(1);
  });

  it('should throw on empty teammates', async () => {
    await expect(planTeam('Task', {
      llmCall: async () => JSON.stringify({ teammates: [], tasks: [{ title: 'T', description: 'D' }] }),
      logger: silentLogger,
    })).rejects.toThrow('at least one teammate');
  });

  it('should throw on empty tasks', async () => {
    await expect(planTeam('Task', {
      llmCall: async () => JSON.stringify({
        teammates: [{ name: 'a', role: 'b', spawnPrompt: 'c' }],
        tasks: [],
      }),
      logger: silentLogger,
    })).rejects.toThrow('at least one task');
  });

  it('should throw on invalid JSON', async () => {
    await expect(planTeam('Task', {
      llmCall: async () => 'not json at all',
      logger: silentLogger,
    })).rejects.toThrow('Plan parsing failed');
  });

  it('should throw on teammate missing name', async () => {
    await expect(planTeam('Task', {
      llmCall: async () => JSON.stringify({
        teammates: [{ name: '', role: 'test', spawnPrompt: '' }],
        tasks: [{ title: 'T', description: 'D' }],
      }),
      logger: silentLogger,
    })).rejects.toThrow('missing name or role');
  });
});

describe('buildTeammateOptionsFromPlan', () => {
  it('should convert plan teammates to TeammateOptions', () => {
    const plan: TeamPlan = {
      teammates: [
        { name: 'researcher', role: 'Research', spawnPrompt: 'Be thorough', model: 'gpt-4o' },
        { name: 'implementer', role: 'Implement', spawnPrompt: 'Build it' },
      ],
      tasks: [],
    };

    const options = buildTeammateOptionsFromPlan(plan, undefined, silentLogger);
    expect(options).toHaveLength(2);
    expect(options[0].name).toBe('researcher');
    expect(options[0].id).toBe('researcher-0');
    expect(options[0].model).toBe('gpt-4o');
    expect(options[0].spawnPrompt).toBe('Be thorough');
    expect(options[1].name).toBe('implementer');
    expect(options[1].id).toBe('implementer-1');
  });
});

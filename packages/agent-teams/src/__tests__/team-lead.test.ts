import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TeamLead } from '../team-lead.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('TeamLead', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'teamlead-test-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('should create a TeamLead with an underlying team', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    expect(lead.team.name).toBe('test-lead');
    expect(lead.team.status).toBe('idle');
    expect(lead.team.members).toHaveLength(0);
  });

  it('should manually setup a team with teammates and tasks', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
      defaultTeammateEngineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.setupTeam(
      [
        { id: 'r1', name: 'researcher', logger: silentLogger, engineOptions: { disableBuiltInPlugins: true } },
        { id: 'i1', name: 'implementer', logger: silentLogger, engineOptions: { disableBuiltInPlugins: true } },
      ],
      [
        { title: 'Research API', description: 'Research the target API' },
        { title: 'Implement integration', description: 'Build the integration', deps: [] },
      ],
    );

    expect(lead.team.members).toHaveLength(2);
    expect(lead.team.getTaskList().getAll()).toHaveLength(2);
  });

  it('should send message to a teammate', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.team.spawnTeammate({
      id: 'mate-1',
      name: 'researcher',
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    lead.sendMessage('mate-1', 'Focus on security aspects');

    const mate = lead.team.getTeammate('mate-1')!;
    const messages = mate.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Focus on security aspects');
  });

  it('should broadcast to all teammates', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.team.spawnTeammates([
      { id: 'a', name: 'alpha', logger: silentLogger, engineOptions: { disableBuiltInPlugins: true } },
      { id: 'b', name: 'beta', logger: silentLogger, engineOptions: { disableBuiltInPlugins: true } },
    ]);

    lead.broadcast('Important update for everyone');

    const a = lead.team.getTeammate('a')!;
    const b = lead.team.getTeammate('b')!;
    expect(a.readMessages().some(m => m.content === 'Important update for everyone')).toBe(true);
    expect(b.readMessages().some(m => m.content === 'Important update for everyone')).toBe(true);
  });

  it('should approve a plan', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.team.spawnTeammate({
      id: 'mate-1',
      name: 'architect',
      requirePlanApproval: true,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    const mate = lead.team.getTeammate('mate-1')!;
    expect(mate.planMode).toBe(true);

    lead.approvePlan('mate-1');

    const approval = mate.checkPlanApproval();
    expect(approval).not.toBeNull();
    expect(approval!.approved).toBe(true);
    expect(mate.planMode).toBe(false);
  });

  it('should reject a plan with feedback', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.team.spawnTeammate({
      id: 'mate-1',
      name: 'architect',
      requirePlanApproval: true,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    const mate = lead.team.getTeammate('mate-1')!;
    lead.rejectPlan('mate-1', 'Needs test coverage');

    const approval = mate.checkPlanApproval();
    expect(approval).not.toBeNull();
    expect(approval!.approved).toBe(false);
    expect(approval!.feedback).toBe('Needs test coverage');
    // Should still be in plan mode after rejection
    expect(mate.planMode).toBe(true);
  });

  it('should read messages sent to lead', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    await lead.team.spawnTeammate({
      id: 'mate-1',
      name: 'researcher',
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    // Simulate teammate sending message to lead
    const mate = lead.team.getTeammate('mate-1')!;
    mate.sendMessage('lead', 'Found a critical bug');

    const leadMessages = lead.readMessages();
    expect(leadMessages).toHaveLength(1);
    expect(leadMessages[0].content).toBe('Found a critical bug');
    expect(leadMessages[0].from).toBe('mate-1');
  });

  it('should subscribe and unsubscribe from events', async () => {
    const lead = new TeamLead({
      teamName: 'test-lead',
      stateDir,
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    await lead.initialize();

    const events: any[] = [];
    const unsub = lead.on(e => events.push(e));

    await lead.team.spawnTeammate({
      id: 'mate-1',
      name: 'researcher',
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    expect(events.some(e => e.type === 'teammate:spawned')).toBe(true);

    unsub();

    await lead.team.spawnTeammate({
      id: 'mate-2',
      name: 'reviewer',
      logger: silentLogger,
      engineOptions: { disableBuiltInPlugins: true },
    });

    const spawnEvents = events.filter(e => e.type === 'teammate:spawned');
    expect(spawnEvents).toHaveLength(1); // Only the first one
  });
});

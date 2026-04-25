import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Teammate } from '../teammate.js';
import { Mailbox } from '../mailbox.js';
import { TaskList } from '../task-list.js';
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  RuntimeContext,
  RuntimeRunOptions,
} from '../runtimes/types.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class FakeRuntime implements AgentRuntime {
  readonly kind = 'pulse' as const;
  initialized = false;
  shutdownCalls = 0;
  lastCall?: RuntimeRunOptions;
  reply: string;

  constructor(public ctx: RuntimeContext, reply = 'fake-reply') {
    this.reply = reply;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async run(options: RuntimeRunOptions): Promise<string> {
    this.lastCall = options;
    options.onText?.(this.reply);
    return this.reply;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('Teammate with custom AgentRuntime factory', () => {
  let stateDir: string;
  let mailbox: Mailbox;
  let taskList: TaskList;
  let runtime: FakeRuntime | undefined;
  const factory: AgentRuntimeFactory = (ctx) => {
    runtime = new FakeRuntime(ctx);
    return runtime;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'teammate-runtime-'));
    mailbox = new Mailbox(stateDir);
    taskList = new TaskList(stateDir);
    runtime = undefined;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('uses the provided factory and forwards the run options', async () => {
    const mate = new Teammate(
      {
        id: 'm1',
        name: 'tester',
        runtime: factory,
        stateDir,
        logger: silentLogger,
      },
      mailbox,
      taskList,
    );
    await mate.initialize();

    expect(runtime?.initialized).toBe(true);
    expect(runtime?.ctx.teammateId).toBe('m1');
    expect(runtime?.ctx.stateDir).toBe(stateDir);

    const out = await mate.run('do something');
    expect(out).toBe('fake-reply');
    expect(runtime?.lastCall?.systemPrompt).toMatch(/Your role: tester/);
    expect(runtime?.lastCall?.prompt).toMatch(/do something/);
  });

  it('prepends pending mailbox messages to the prompt', async () => {
    mailbox.send('lead', 'm2', 'message', 'remember to commit');
    const mate = new Teammate(
      {
        id: 'm2',
        name: 'tester',
        runtime: factory,
        stateDir,
        logger: silentLogger,
      },
      mailbox,
      taskList,
    );
    await mate.initialize();
    await mate.run('main task');
    expect(runtime?.lastCall?.prompt).toMatch(/Unread messages/);
    expect(runtime?.lastCall?.prompt).toMatch(/remember to commit/);
  });

  it('calls runtime.shutdown on requestShutdown', async () => {
    const mate = new Teammate(
      {
        id: 'm3',
        name: 'tester',
        runtime: factory,
        stateDir,
        logger: silentLogger,
      },
      mailbox,
      taskList,
    );
    await mate.initialize();
    await mate.requestShutdown();
    expect(runtime?.shutdownCalls).toBe(1);
    expect(mate.status).toBe('stopped');
  });

  it('exposes runtimeKind for UI badges', async () => {
    const mate = new Teammate(
      {
        id: 'm4',
        name: 'tester',
        runtime: factory,
        stateDir,
        logger: silentLogger,
      },
      mailbox,
      taskList,
    );
    await mate.initialize();
    expect(mate.runtimeKind).toBe('pulse');
  });
});

import { Engine } from 'pulse-coder-engine';
import { memoryIntegration } from './memory-integration.js';
import { worktreeIntegration } from './worktree/integration.js';

export interface EngineLifecycleSnapshot {
  generation: number;
  previousGeneration: number;
  renewedAt: number;
  reason: string;
}

interface EngineState {
  engine: Engine;
  generation: number;
  createdAt: number;
}

let state: EngineState | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();

function createEngine(): Engine {
  return new Engine({
    enginePlugins: {
      plugins: [
        memoryIntegration.enginePlugin,
        worktreeIntegration.enginePlugin,
      ],
    },
  });
}

async function runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = lifecycleQueue.then(operation, operation);
  lifecycleQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function initializeEngine(): Promise<Engine> {
  return runLifecycleOperation(async () => {
    if (state) {
      return state.engine;
    }

    const engine = createEngine();
    await engine.initialize();
    state = {
      engine,
      generation: 1,
      createdAt: Date.now(),
    };

    return engine;
  });
}

export async function getOrInitializeEngine(): Promise<Engine> {
  if (state) {
    return state.engine;
  }

  return initializeEngine();
}

export function tryGetEngine(): Engine | undefined {
  return state?.engine;
}

export async function renewEngine(reason: string): Promise<EngineLifecycleSnapshot> {
  return runLifecycleOperation(async () => {
    const previousGeneration = state?.generation ?? 0;
    const engine = createEngine();
    await engine.initialize();

    state = {
      engine,
      generation: previousGeneration + 1,
      createdAt: Date.now(),
    };

    return {
      generation: state.generation,
      previousGeneration,
      renewedAt: state.createdAt,
      reason,
    };
  });
}

export function getEngineLifecycleInfo(): { generation: number; createdAt: number } {
  if (!state) {
    return {
      generation: 0,
      createdAt: 0,
    };
  }

  return {
    generation: state.generation,
    createdAt: state.createdAt,
  };
}

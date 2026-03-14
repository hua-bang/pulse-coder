import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { AcpChannelState, AcpStateStore } from './types.js';

const DEFAULT_STATE_PATH = join(homedir(), '.pulse-coder', 'acp-state.json');

type StateFile = Record<string, AcpChannelState>;

async function readAll(statePath: string): Promise<StateFile> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StateFile;
    }
  } catch {
    // file missing or corrupt -> start fresh
  }
  return {};
}

async function writeAll(statePath: string, data: StateFile): Promise<void> {
  await fs.mkdir(dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export class FileAcpStateStore implements AcpStateStore {
  private statePath: string;

  constructor(statePath: string = DEFAULT_STATE_PATH) {
    this.statePath = statePath;
  }

  async getState(platformKey: string): Promise<AcpChannelState | undefined> {
    const data = await readAll(this.statePath);
    return data[platformKey];
  }

  async setState(platformKey: string, state: AcpChannelState): Promise<void> {
    const data = await readAll(this.statePath);
    data[platformKey] = state;
    await writeAll(this.statePath, data);
  }

  async clearState(platformKey: string): Promise<void> {
    const data = await readAll(this.statePath);
    delete data[platformKey];
    await writeAll(this.statePath, data);
  }

  async updateCwd(platformKey: string, cwd: string): Promise<boolean> {
    const data = await readAll(this.statePath);
    if (!data[platformKey]) return false;
    data[platformKey]!.cwd = cwd;
    delete data[platformKey]!.sessionId;
    await writeAll(this.statePath, data);
    return true;
  }

  async saveSessionId(platformKey: string, sessionId: string): Promise<void> {
    const data = await readAll(this.statePath);
    if (data[platformKey]) {
      data[platformKey]!.sessionId = sessionId;
      await writeAll(this.statePath, data);
    }
  }
}

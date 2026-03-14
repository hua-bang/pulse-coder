import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type AcpAgent = 'claude' | 'codex';

export interface AcpChannelState {
  agent: AcpAgent;
  cwd: string;
  sessionId?: string;
}

type StateFile = Record<string, AcpChannelState>;

const STATE_PATH = join(homedir(), '.pulse-coder', 'acp-state.json');

async function readAll(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StateFile;
    }
  } catch {
    // file missing or corrupt → start fresh
  }
  return {};
}

async function writeAll(data: StateFile): Promise<void> {
  await fs.mkdir(join(homedir(), '.pulse-coder'), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function getAcpState(platformKey: string): Promise<AcpChannelState | undefined> {
  const data = await readAll();
  return data[platformKey];
}

export async function setAcpState(platformKey: string, state: AcpChannelState): Promise<void> {
  const data = await readAll();
  data[platformKey] = state;
  await writeAll(data);
}

export async function clearAcpState(platformKey: string): Promise<void> {
  const data = await readAll();
  delete data[platformKey];
  await writeAll(data);
}

export async function updateAcpCwd(platformKey: string, cwd: string): Promise<boolean> {
  const data = await readAll();
  if (!data[platformKey]) return false;
  data[platformKey]!.cwd = cwd;
  // reset session since cwd changed
  delete data[platformKey]!.sessionId;
  await writeAll(data);
  return true;
}

export async function saveAcpSessionId(platformKey: string, sessionId: string): Promise<void> {
  const data = await readAll();
  if (data[platformKey]) {
    data[platformKey]!.sessionId = sessionId;
    await writeAll(data);
  }
}

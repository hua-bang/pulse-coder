import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

type ModelConfig = {
  current_model?: string;
  models?: Array<{
    name?: string;
  }>;
};

type CachedConfig = {
  path: string;
  mtimeMs: number;
  data: ModelConfig | null;
};

let cachedConfig: CachedConfig | null = null;

function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function findConfigPath(): Promise<string | null> {
  const candidates: string[] = [];
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  if (envPath) {
    candidates.push(envPath);
  }

  candidates.push(resolve(process.cwd(), '.pulse-coder', 'config.json'));
  candidates.push(join(homedir(), '.pulse-coder', 'config.json'));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing files.
    }
  }

  return null;
}

async function readConfig(path: string): Promise<ModelConfig | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ModelConfig;
  } catch (error) {
    console.warn('[model-config] failed to parse model config:', error);
    return null;
  }
}

function selectModel(config: ModelConfig | null): string | null {
  if (!config) {
    return null;
  }

  const current = normalizeModel(config.current_model);
  if (current) {
    return current;
  }

  const firstModel = Array.isArray(config.models) ? config.models[0] : null;
  return normalizeModel(firstModel?.name);
}

export async function resolveModelForRun(_platformKey: string): Promise<string | undefined> {
  const configPath = await findConfigPath();
  if (!configPath) {
    return undefined;
  }

  try {
    const stat = await fs.stat(configPath);
    if (cachedConfig && cachedConfig.path === configPath && cachedConfig.mtimeMs === stat.mtimeMs) {
      return selectModel(cachedConfig.data) ?? undefined;
    }

    const data = await readConfig(configPath);
    cachedConfig = { path: configPath, mtimeMs: stat.mtimeMs, data };
    return selectModel(data) ?? undefined;
  } catch {
    return undefined;
  }
}

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';

type ModelConfig = {
  current_model?: string;
  models?: Array<{
    name?: string;
  }>;
};

type ModelConfigWriteResult = {
  path: string;
  config: ModelConfig;
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

async function loadConfigFromPath(
  path: string,
  options?: { warn?: boolean },
): Promise<ModelConfig | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ModelConfig;
  } catch (error) {
    if (options?.warn) {
      console.warn('[model-config] failed to parse model config:', error);
    }
    return null;
  }
}

async function ensureConfigDir(path: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
}

export async function writeModelConfig(next: ModelConfig): Promise<ModelConfigWriteResult> {
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  const configPath = await findConfigPath();
  const path = envPath || configPath || resolve(process.cwd(), '.pulse-coder', 'config.json');

  await ensureConfigDir(path);
  const existing = await loadConfigFromPath(path, { warn: true });
  const merged: ModelConfig = {
    ...(existing ?? {}),
    ...next,
  };

  const payload = `${JSON.stringify(merged, null, 2)}\n`;
  await fs.writeFile(path, payload, 'utf8');

  try {
    const stat = await fs.stat(path);
    cachedConfig = { path, mtimeMs: stat.mtimeMs, data: merged };
  } catch {
    cachedConfig = { path, mtimeMs: 0, data: merged };
  }

  return { path, config: merged };
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

    const data = await loadConfigFromPath(configPath, { warn: true });
    if (!data) {
      return undefined;
    }
    cachedConfig = { path: configPath, mtimeMs: stat.mtimeMs, data };
    return selectModel(data) ?? undefined;
  } catch {
    return undefined;
  }
}

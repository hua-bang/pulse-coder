import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';

type ModelOption = {
  name: string;
  provider_type?: 'openai' | 'claude';
};

type ModelConfig = {
  current_model?: string;
  provider_type?: 'openai' | 'claude';
  options?: ModelOption[];
  models?: Array<{
    name?: string;
  }>;
};

type ModelConfigWriteResult = {
  path: string;
  config: ModelConfig;
};

type ModelStatus = {
  path: string | null;
  currentModel?: string;
  providerType?: 'openai' | 'claude';
  resolvedModel?: string;
  options?: ModelOption[];
  models?: string[];
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

  await refreshCache(path, merged);
  return { path, config: merged };
}

async function refreshCache(path: string, data: ModelConfig | null): Promise<void> {
  try {
    const stat = await fs.stat(path);
    cachedConfig = { path, mtimeMs: stat.mtimeMs, data };
  } catch {
    cachedConfig = { path, mtimeMs: 0, data };
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

export async function clearModelOverride(): Promise<ModelConfigWriteResult> {
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  const configPath = await findConfigPath();
  if (!envPath && !configPath) {
    throw new Error('Model config file not found');
  }
  const path = envPath || configPath || resolve(process.cwd(), '.pulse-coder', 'config.json');

  await ensureConfigDir(path);
  const existing = await loadConfigFromPath(path, { warn: true });
  const merged: ModelConfig = {
    ...(existing ?? {}),
  };
  delete merged.current_model;

  const payload = `${JSON.stringify(merged, null, 2)}\n`;
  await fs.writeFile(path, payload, 'utf8');

  await refreshCache(path, merged);
  return { path, config: merged };
}

export async function getModelStatus(): Promise<ModelStatus> {
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  const configPath = await findConfigPath();
  const path = envPath || configPath || null;
  if (!path) {
    return { path: null };
  }

  let data: ModelConfig | null = null;
  try {
    const stat = await fs.stat(path);
    if (cachedConfig && cachedConfig.path === path && cachedConfig.mtimeMs === stat.mtimeMs) {
      data = cachedConfig.data;
    } else {
      data = await loadConfigFromPath(path, { warn: true });
      if (data) {
        cachedConfig = { path, mtimeMs: stat.mtimeMs, data };
      }
    }
  } catch {
    return { path };
  }

  const resolvedModel = selectModel(data);
  const models = Array.isArray(data?.models)
    ? data?.models
        .map((item) => normalizeModel(item?.name))
        .filter((name): name is string => Boolean(name))
    : undefined;

  return {
    path,
    currentModel: normalizeModel(data?.current_model) ?? undefined,
    providerType: data?.provider_type,
    resolvedModel: resolvedModel ?? undefined,
    options: Array.isArray(data?.options) && data.options.length > 0 ? data.options : undefined,
    models: models && models.length > 0 ? models : undefined,
  };
}

export async function resolveModelOption(name: string): Promise<ModelOption | null> {
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  const configPath = await findConfigPath();
  const path = envPath || configPath || null;
  if (!path) return null;

  try {
    const stat = await fs.stat(path);
    let data: ModelConfig | null;
    if (cachedConfig && cachedConfig.path === path && cachedConfig.mtimeMs === stat.mtimeMs) {
      data = cachedConfig.data;
    } else {
      data = await loadConfigFromPath(path, { warn: true });
      if (data) cachedConfig = { path, mtimeMs: stat.mtimeMs, data };
    }
    return data?.options?.find((o) => o.name === name) ?? null;
  } catch {
    return null;
  }
}

export async function resolveModelForRun(_platformKey: string): Promise<{ model?: string; modelType?: 'openai' | 'claude' }> {
  const envPath = process.env.PULSE_CODER_MODEL_CONFIG?.trim();
  const configPath = await findConfigPath();
  const path = envPath || configPath || null;
  if (!path) {
    return {};
  }

  try {
    const stat = await fs.stat(path);
    if (cachedConfig && cachedConfig.path === path && cachedConfig.mtimeMs === stat.mtimeMs) {
      return {
        model: selectModel(cachedConfig.data) ?? undefined,
        modelType: cachedConfig.data?.provider_type,
      };
    }

    const data = await loadConfigFromPath(path, { warn: true });
    if (!data) {
      return {};
    }
    cachedConfig = { path, mtimeMs: stat.mtimeMs, data };
    return {
      model: selectModel(data) ?? undefined,
      modelType: data.provider_type,
    };
  } catch {
    return {};
  }
}


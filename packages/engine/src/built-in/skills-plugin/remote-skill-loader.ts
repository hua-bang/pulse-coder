/**
 * Remote Skill Loader
 * 从远程 endpoint 拉取 skill 元数据与内容
 *
 * 远程 endpoint 协议 (GET <endpoint>):
 * {
 *   "skills": [
 *     {
 *       "name": "skill-name",          // 必填
 *       "description": "...",          // 必填
 *       "content": "# Markdown...",    // 必填，skill 正文（等同于 SKILL.md body）
 *       "version": "1.0.0",            // 可选
 *       "author": "...",               // 可选
 *       [key: string]: any             // 其他自定义元数据
 *     }
 *   ]
 * }
 *
 * 本地配置文件（任选其一，按优先级从高到低）：
 *   .pulse-coder/remote-skills.json / .yaml / .yml   （项目级）
 *   .coder/remote-skills.json / .yaml / .yml          （项目级，兼容旧版）
 *   ~/.pulse-coder/remote-skills.json / .yaml / .yml  （用户级）
 *   ~/.coder/remote-skills.json / .yaml / .yml         （用户级，兼容旧版）
 *
 * 配置文件格式（JSON 示例）：
 * {
 *   "endpoints": ["https://skills.example.com/api/skills"],
 *   "headers": { "Authorization": "Bearer ${SKILL_API_TOKEN}" },
 *   "timeout": 8000
 * }
 *
 * 支持 ${ENV_VAR} 和 ${ENV_VAR:-defaultValue} 环境变量占位符。
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import type { SkillInfo } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 远程 endpoint 响应中单条 skill 的结构 */
export interface RemoteSkillEntry {
  name: string;
  description: string;
  content: string;
  version?: string;
  author?: string;
  [key: string]: unknown;
}

/** 远程 endpoint 响应体结构 */
export interface RemoteSkillEndpointResponse {
  skills: RemoteSkillEntry[];
}

/** 远程 skill 加载配置 */
export interface RemoteSkillConfig {
  /**
   * 一个或多个远程 skill endpoint URL。
   * 每个 endpoint 必须支持 GET 请求并返回 RemoteSkillEndpointResponse 格式的 JSON。
   */
  endpoints: string | string[];

  /**
   * 请求超时（毫秒），默认 5000ms。
   */
  timeout?: number;

  /**
   * 自定义请求头，例如用于鉴权：{ Authorization: 'Bearer <token>' }
   */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * 从单个远程 endpoint 拉取 skill 列表。
 * 若请求失败或响应格式非法，会打印警告并返回空数组（不抛错，保证 engine 启动不中断）。
 */
export async function loadRemoteSkillsFromEndpoint(
  endpoint: string,
  options?: Pick<RemoteSkillConfig, 'timeout' | 'headers'>
): Promise<SkillInfo[]> {
  const timeout = options?.timeout ?? 5000;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...options?.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[RemoteSkills] Failed to fetch ${endpoint}: ${reason}`);
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[RemoteSkills] Endpoint ${endpoint} returned HTTP ${response.status} ${response.statusText}`
    );
    return [];
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    console.warn(`[RemoteSkills] Endpoint ${endpoint} returned non-JSON response`);
    return [];
  }

  if (!isValidResponse(json)) {
    console.warn(
      `[RemoteSkills] Endpoint ${endpoint} response is missing "skills" array`
    );
    return [];
  }

  const skills: SkillInfo[] = [];

  for (const entry of json.skills) {
    if (!isValidEntry(entry)) {
      console.warn(
        `[RemoteSkills] Skipping entry from ${endpoint}: missing required fields (name, description, content)`
      );
      continue;
    }

    const { name, description, content, ...rest } = entry;

    skills.push({
      name: name.trim(),
      description,
      content,
      location: endpoint,
      metadata: {
        ...rest,
        remote: true,
        source: endpoint,
      },
    });
  }

  return skills;
}

/**
 * 从多个 endpoint 批量拉取 skill，并发执行。
 */
export async function loadRemoteSkills(
  config: RemoteSkillConfig
): Promise<SkillInfo[]> {
  const endpoints = Array.isArray(config.endpoints)
    ? config.endpoints
    : [config.endpoints];

  const results = await Promise.all(
    endpoints.map((ep) =>
      loadRemoteSkillsFromEndpoint(ep, {
        timeout: config.timeout,
        headers: config.headers,
      })
    )
  );

  return results.flat();
}

// ---------------------------------------------------------------------------
// Config file discovery
// ---------------------------------------------------------------------------

/** 配置文件名（不含扩展名） */
const CONFIG_FILENAME = 'remote-skills';

/** 配置文件支持的扩展名，按优先级排列 */
const CONFIG_EXTS = ['.json', '.yaml', '.yml'] as const;

/**
 * 从本地配置文件中读取远程 skill 配置。
 *
 * 扫描顺序（先找到先用）：
 *   1. <cwd>/.pulse-coder/remote-skills.{json,yaml,yml}
 *   2. <cwd>/.coder/remote-skills.{json,yaml,yml}
 *   3. ~/.pulse-coder/remote-skills.{json,yaml,yml}
 *   4. ~/.coder/remote-skills.{json,yaml,yml}
 *
 * 配置文件内容示例（JSON）：
 * {
 *   "endpoints": "https://skills.example.com/api/skills",
 *   "headers": { "Authorization": "Bearer ${SKILL_API_TOKEN}" },
 *   "timeout": 8000
 * }
 */
export async function readRemoteSkillsConfigFile(
  cwd: string
): Promise<RemoteSkillConfig | null> {
  const home = homedir();

  const searchDirs = [
    path.join(cwd, '.pulse-coder'),
    path.join(cwd, '.coder'),
    path.join(home, '.pulse-coder'),
    path.join(home, '.coder'),
  ];

  for (const dir of searchDirs) {
    for (const ext of CONFIG_EXTS) {
      const filePath = path.join(dir, `${CONFIG_FILENAME}${ext}`);
      const parsed = tryReadConfigFile(filePath, ext);
      if (parsed) {
        console.log(`[RemoteSkills] Loaded config from ${filePath}`);
        return resolveEnvVars(parsed);
      }
    }
  }

  return null;
}

/**
 * 合并来自配置文件和代码两处的远程 skill 配置，去重 endpoint URL。
 * 代码传入的配置（programmatic）优先：其 headers / timeout 会覆盖文件配置。
 *
 * @returns 合并后的统一配置，若两者均为空则返回 null。
 */
export function mergeRemoteSkillConfigs(
  fileConfig: RemoteSkillConfig | null,
  programmaticConfig: RemoteSkillConfig | undefined
): RemoteSkillConfig | null {
  const fileEndpoints = fileConfig
    ? toArray(fileConfig.endpoints)
    : [];
  const codeEndpoints = programmaticConfig
    ? toArray(programmaticConfig.endpoints)
    : [];

  // 合并，去重
  const allEndpoints = Array.from(new Set([...fileEndpoints, ...codeEndpoints]));

  if (allEndpoints.length === 0) return null;

  // 代码配置的 headers / timeout 优先；文件配置作为兜底
  return {
    endpoints: allEndpoints,
    timeout: programmaticConfig?.timeout ?? fileConfig?.timeout,
    headers: {
      ...(fileConfig?.headers ?? {}),
      ...(programmaticConfig?.headers ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidResponse(json: unknown): json is RemoteSkillEndpointResponse {
  return (
    typeof json === 'object' &&
    json !== null &&
    'skills' in json &&
    Array.isArray((json as Record<string, unknown>).skills)
  );
}

function isValidEntry(entry: unknown): entry is RemoteSkillEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.name === 'string' &&
    e.name.trim().length > 0 &&
    typeof e.description === 'string' &&
    typeof e.content === 'string'
  );
}

/** 同步尝试读取并解析配置文件，失败返回 null */
function tryReadConfigFile(
  filePath: string,
  ext: string
): RemoteSkillConfig | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (ext === '.json') {
      return JSON.parse(content) as RemoteSkillConfig;
    }
    // YAML：同步解析，用轻量级手写解析避免 await
    // 只需处理简单的 key: value 结构，使用 yaml 包的同步 API
    const yaml = requireYAML();
    return yaml ? (yaml.parse(content) as RemoteSkillConfig) : null;
  } catch {
    return null;
  }
}

/** 动态 require yaml（兼容 ESM 环境下的同步调用） */
function requireYAML(): { parse(content: string): unknown } | null {
  try {
    // yaml 包提供同步 parse API，可在 ESM 中直接使用已缓存的模块
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('yaml') as { parse(content: string): unknown };
  } catch {
    return null;
  }
}

/**
 * 替换配置值中的环境变量占位符。
 * 支持 ${VAR} 和 ${VAR:-default}。
 */
function resolveEnvVars(config: RemoteSkillConfig): RemoteSkillConfig {
  return deepResolve(config) as RemoteSkillConfig;
}

function deepResolve(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [varName, defaultVal] = expr.split(':-');
      return process.env[varName.trim()] ?? defaultVal ?? _match;
    });
  }
  if (Array.isArray(value)) return value.map(deepResolve);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepResolve(v);
    }
    return out;
  }
  return value;
}

function toArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

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
 */

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

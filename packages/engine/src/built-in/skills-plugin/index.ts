/**
 * Built-in Skills Plugin for Pulse Coder Engine
 * 将技能系统作为引擎内置插件
 */

import { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import { Tool } from '../../shared/types';
import { readFileSync, existsSync } from 'fs';
import { globSync } from 'glob';
import matter from 'gray-matter';
import { homedir } from 'os';
import * as path from 'path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Remote skills config
// ---------------------------------------------------------------------------

export interface RemoteSkillEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface RemoteSkillsConfig {
  endpoints: RemoteSkillEndpoint[];
}

export async function loadRemoteSkillsConfig(cwd: string): Promise<RemoteSkillsConfig> {
  const configPath = path.join(cwd, '.pulse-coder', 'remote-skills.json');
  if (!existsSync(configPath)) {
    return { endpoints: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!Array.isArray(parsed.endpoints)) {
      console.warn('[Skills] remote-skills.json missing "endpoints" array');
      return { endpoints: [] };
    }
    return { endpoints: parsed.endpoints };
  } catch (error) {
    console.warn(`[Skills] Failed to load remote-skills.json: ${error instanceof Error ? error.message : error}`);
    return { endpoints: [] };
  }
}

async function fetchRemoteSkills(endpoints: RemoteSkillEndpoint[]): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, {
        headers: { 'Accept': 'application/json', ...(endpoint.headers ?? {}) }
      });
      if (!res.ok) {
        console.warn(`[Skills] Remote endpoint ${endpoint.url} returned ${res.status}`);
        continue;
      }
      const data = await res.json() as unknown;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const { name, description, content } = item as Record<string, unknown>;
        if (typeof name !== 'string' || typeof description !== 'string') {
          console.warn(`[Skills] Skipping remote skill with missing name/description from ${endpoint.url}`);
          continue;
        }
        skills.push({
          name,
          description,
          location: endpoint.url,
          content: typeof content === 'string' ? content : '',
          metadata: { remote: true, source: endpoint.url }
        });
      }
      console.log(`[Skills] Loaded ${items.length} remote skill(s) from ${endpoint.url}`);
    } catch (error) {
      console.warn(`[Skills] Failed to fetch remote skills from ${endpoint.url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return skills;
}

/**
 * 技能信息接口
 */
export interface SkillInfo {
  name: string;
  description: string;
  location: string;
  content: string;
  metadata?: Record<string, any>;
}

/**
 * 技能注册表
 */
export class BuiltInSkillRegistry {
  private skills: Map<string, SkillInfo> = new Map();
  private initialized = false;

  /**
   * 初始化注册表，扫描并加载所有技能（含远程）
   */
  async initialize(cwd: string): Promise<void> {
    if (this.initialized) {
      console.warn('SkillRegistry already initialized');
      return;
    }

    console.log('Scanning built-in skills...');
    const skillList = await this.scanSkills(cwd);

    this.skills.clear();
    for (const skill of skillList) {
      this.skills.set(skill.name, skill);
    }

    // 加载远程技能
    const remoteConfig = await loadRemoteSkillsConfig(cwd);
    if (remoteConfig.endpoints.length > 0) {
      const remoteSkills = await fetchRemoteSkills(remoteConfig.endpoints);
      for (const skill of remoteSkills) {
        this.skills.set(skill.name, skill);
      }
    }

    this.initialized = true;
    console.log(`Loaded ${this.skills.size} skill(s) total`);
  }

  /**
   * 扫描技能文件
   */
  private async scanSkills(cwd: string): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];

    const scanPaths = [
      // 项目级技能（优先 .pulse-coder，兼容旧版 .coder 和 .claude）
      { base: cwd, pattern: '.pulse-coder/skills/**/SKILL.md' },
      { base: cwd, pattern: '.coder/skills/**/SKILL.md' },
      { base: cwd, pattern: '.claude/skills/**/SKILL.md' },
      // 用户级技能（优先 .pulse-coder，兼容旧版 .coder）
      { base: homedir(), pattern: '.pulse-coder/skills/**/SKILL.md' },
      { base: homedir(), pattern: '.coder/skills/**/SKILL.md' }
    ];

    for (const { base, pattern } of scanPaths) {
      try {
        const files = globSync(pattern, { cwd: base, absolute: true });

        for (const filePath of files) {
          try {
            const skillInfo = this.parseSkillFile(filePath);
            if (skillInfo) {
              skills.push(skillInfo);
            }
          } catch (error) {
            console.warn(`Failed to parse skill file ${filePath}:`, error);
          }
        }
      } catch (error) {
        console.debug(`Skip scanning ${pattern} in ${base}:`, error);
      }
    }

    return skills;
  }

  /**
   * 解析技能文件
   */
  private parseSkillFile(filePath: string): SkillInfo | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const { data, content: markdownContent } = matter(content);

      if (!data.name || !data.description) {
        console.warn(`Skill file ${filePath} missing required fields (name or description)`);
        return null;
      }

      return {
        name: data.name,
        description: data.description,
        location: filePath,
        content: markdownContent,
        metadata: data
      };
    } catch (error) {
      console.warn(`Failed to read skill file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 获取所有技能
   */
  getAll(): SkillInfo[] {
    return Array.from(this.skills.values());
  }

  /**
   * 注册或更新一个技能（支持插件在运行期追加技能）
   */
  registerSkill(skill: SkillInfo): { skillName: string; replaced: boolean; total: number } {
    const name = skill.name?.trim();
    if (!name) {
      throw new Error('Skill name is required');
    }

    const existingKey = Array.from(this.skills.keys()).find((key) => key.toLowerCase() === name.toLowerCase());
    const replaced = existingKey !== undefined;

    if (existingKey && existingKey !== name) {
      this.skills.delete(existingKey);
    }

    this.skills.set(name, {
      ...skill,
      name
    });

    return {
      skillName: name,
      replaced,
      total: this.skills.size
    };
  }

  /**
   * 根据名称获取技能（大小写不敏感）
   */
  get(name: string): SkillInfo | undefined {
    const exact = this.skills.get(name);
    if (exact) {
      return exact;
    }

    const target = name.toLowerCase();
    return this.getAll().find((skill) => skill.name.toLowerCase() === target);
  }

  /**
   * 检查技能是否存在
   */
  has(name: string): boolean {
    return !!this.get(name);
  }

  /**
   * 搜索技能（模糊匹配）
   */
  search(keyword: string): SkillInfo[] {
    const lowerKeyword = keyword.toLowerCase();
    return this.getAll().filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerKeyword) ||
        skill.description.toLowerCase().includes(lowerKeyword)
    );
  }
}

/**
 * 技能工具参数 schema
 */
const skillToolSchema = z.object({
  name: z.string().describe('The name of the skill to execute')
});

type SkillToolInput = z.infer<typeof skillToolSchema>;

/**
 * 生成技能工具
 */
function generateSkillTool(registry: BuiltInSkillRegistry): Tool<SkillToolInput, SkillInfo> {
  const getSkillsPrompt = (availableSkills: SkillInfo[]) => {
    return [
      "If query matches an available skill's description or instruction [use skill], use the skill tool to get detailed instructions.",
      "Load a skill to get detailed instructions for a specific task.",
      "Skills provide specialized knowledge and step-by-step guidance.",
      "Use this when a task matches an available skill's description.",
      "Only the skills listed here are available:",
      "[!important] You should follow the skill's step-by-step guidance. If the skill is not complete, ask the user for more information.",
      "<available_skills>",
      ...availableSkills.flatMap((skill) => [
        `  <skill>`,
        `    <name>${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
        `  </skill>`
      ]),
      "</available_skills>"
    ].join(" ");
  };

  return {
    name: "skill",
    description: getSkillsPrompt(registry.getAll()),
    inputSchema: skillToolSchema,
    execute: async ({ name }) => {
      const skill = registry.get(name);
      if (!skill) {
        throw new Error(`Skill ${name} not found`);
      }
      return skill;
    }
  };
}

/**
 * 内置技能插件
 */
export const builtInSkillsPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-skills',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const registry = new BuiltInSkillRegistry();
    await registry.initialize(process.cwd());

    context.registerService('skillRegistry', registry);
    context.registerTool('skill', generateSkillTool(registry));

    context.registerHook('beforeRun', ({ tools }) => {
      return {
        tools: {
          ...tools,
          skill: generateSkillTool(registry)
        }
      };
    });

    const skills = registry.getAll();
    if (skills.length === 0) {
      console.log('[Skills] No skills found');
      return;
    }

    console.log(`[Skills] Registered ${skills.length} skill(s)`);
  }
};

export default builtInSkillsPlugin;
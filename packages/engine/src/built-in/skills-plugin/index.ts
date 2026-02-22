/**
 * Built-in Skills Plugin for Pulse Coder Engine
 * 将技能系统作为引擎内置插件
 */

import { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import { Tool } from '../../shared/types';
import { readFileSync } from 'fs';
import { globSync } from 'glob';
import matter from 'gray-matter';
import { homedir } from 'os';
import { z } from 'zod';
import {
  loadRemoteSkills,
  readRemoteSkillsConfigFile,
  mergeRemoteSkillConfigs,
  type RemoteSkillConfig,
} from './remote-skill-loader.js';

export type { RemoteSkillConfig } from './remote-skill-loader.js';

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
   * 初始化注册表，扫描并加载所有技能
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

    this.initialized = true;
    console.log(`Loaded ${this.skills.size} built-in skill(s)`);
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
   * 从远程 endpoints 加载 skill，并合并到注册表。
   * 远程 skill 与本地 skill 同名时，本地优先（本地已存在则跳过远程）。
   */
  async loadRemoteEndpoints(config: RemoteSkillConfig): Promise<number> {
    const remoteSkills = await loadRemoteSkills(config);
    let added = 0;

    for (const skill of remoteSkills) {
      if (this.has(skill.name)) {
        console.debug(`[RemoteSkills] Skipping remote skill "${skill.name}" (local version exists)`);
        continue;
      }
      this.skills.set(skill.name, skill);
      added++;
    }

    return added;
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

/** Options accepted by createBuiltInSkillsPlugin */
export interface BuiltInSkillsPluginOptions {
  /**
   * 远程 skill 配置。
   * 提供后，engine 初始化时会并发拉取所有 endpoint 的 skill 列表，
   * 本地同名 skill 优先（不会被远程覆盖）。
   */
  remoteSkills?: RemoteSkillConfig;
}

/**
 * 创建内置技能插件（工厂函数）。
 *
 * @example 基础用法（仅本地 skill）
 * createBuiltInSkillsPlugin()
 *
 * @example 带远程 endpoint
 * createBuiltInSkillsPlugin({
 *   remoteSkills: {
 *     endpoints: 'https://skills.example.com/api/skills',
 *     headers: { Authorization: 'Bearer <token>' },
 *   }
 * })
 */
export function createBuiltInSkillsPlugin(
  options?: BuiltInSkillsPluginOptions
): EnginePlugin {
  return {
    name: 'pulse-coder-engine/built-in-skills',
    version: '1.0.0',

    async initialize(context: EnginePluginContext) {
      const registry = new BuiltInSkillRegistry();
      await registry.initialize(process.cwd());

      // 加载远程 skill：
      //   1. 自动扫描 .pulse-coder/remote-skills.{json,yaml,yml} 等配置文件
      //   2. 与代码传入的 options.remoteSkills 合并（代码配置优先）
      const fileConfig = await readRemoteSkillsConfigFile(process.cwd());
      const mergedRemoteConfig = mergeRemoteSkillConfigs(fileConfig, options?.remoteSkills);

      if (mergedRemoteConfig) {
        const endpoints = Array.isArray(mergedRemoteConfig.endpoints)
          ? mergedRemoteConfig.endpoints
          : [mergedRemoteConfig.endpoints];
        console.log(`[Skills] Loading remote skills from ${endpoints.length} endpoint(s)...`);
        const added = await registry.loadRemoteEndpoints(mergedRemoteConfig);
        console.log(`[Skills] Loaded ${added} remote skill(s)`);
      }

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
}

/**
 * 内置技能插件（默认实例，仅加载本地 skill）。
 * 需要远程 skill 时请使用 createBuiltInSkillsPlugin({ remoteSkills: ... })。
 */
export const builtInSkillsPlugin: EnginePlugin = createBuiltInSkillsPlugin();

export default builtInSkillsPlugin;
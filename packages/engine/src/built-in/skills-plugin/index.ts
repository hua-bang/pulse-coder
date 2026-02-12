/**
 * Built-in Skills Plugin for Coder Engine
 * 将技能系统作为引擎内置插件
 */

import { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import { Tool } from '../../shared/types';
import { existsSync, readFileSync } from 'fs';
import { globSync } from 'glob';
import matter from 'gray-matter';
import { homedir } from 'os';
import * as path from 'path';
import { z } from 'zod';

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
      // 项目级技能
      { base: cwd, pattern: '.coder/skills/**/SKILL.md' },
      { base: cwd, pattern: '.claude/skills/**/SKILL.md' },
      // 用户级技能
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
   * 根据名称获取技能
   */
  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /**
   * 检查技能是否存在
   */
  has(name: string): boolean {
    return this.skills.has(name);
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
function generateSkillTool(skills: SkillInfo[]): Tool<SkillToolInput, SkillInfo> {
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
    description: getSkillsPrompt(skills),
    inputSchema: skillToolSchema,
    execute: async ({ name }) => {
      const skill = skills.find((skill) => skill.name === name);
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
  name: '@coder/engine/built-in-skills',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const registry = new BuiltInSkillRegistry();
    await registry.initialize(process.cwd());

    const skills = registry.getAll();
    if (skills.length === 0) {
      console.log('[Skills] No skills found');
      return;
    }

    const skillTool = generateSkillTool(skills);
    context.registerTool('skill', skillTool);
    context.registerService('skillRegistry', registry);

    console.log(`[Skills] Registered ${skills.length} skill(s)`);
  }
};

export default builtInSkillsPlugin;
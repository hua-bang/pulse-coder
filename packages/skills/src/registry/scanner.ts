import { globSync } from 'glob';
import { readFileSync } from 'fs';
import matter from 'gray-matter';
import type { SkillInfo, SkillFrontmatter } from './skill-types';
import { homedir } from 'os';

/**
 * 扫描指定目录下的技能文件
 * @param cwd 工作目录
 * @returns 技能信息列表
 */
export function scanSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  // 扫描路径配置
  const scanPaths = [
    // 项目级技能
    { base: cwd, pattern: '.coder/skills/**/SKILL.md' },
    { base: cwd, pattern: '.claude/skills/**/SKILL.md' },
    // 用户级技能
    { base: homedir(), pattern: '.coder/skills/**/SKILL.md' },
  ];

  for (const { base, pattern } of scanPaths) {
    try {
      const files = globSync(pattern, { cwd: base, absolute: true });

      for (const filePath of files) {
        try {
          const skillInfo = parseSkillFile(filePath);
          if (skillInfo) {
            skills.push(skillInfo);
          }
        } catch (error) {
          console.warn(`Failed to parse skill file ${filePath}:`, error);
        }
      }
    } catch (error) {
      // 忽略扫描错误（比如目录不存在）
      console.debug(`Skip scanning ${pattern} in ${base}:`, error);
    }
  }

  return skills;
}

/**
 * 解析单个技能文件
 * @param filePath 文件路径
 * @returns 技能信息，如果解析失败则返回 null
 */
function parseSkillFile(filePath: string): SkillInfo | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const { data, content: markdownContent } = matter(content);

    // 验证必需字段
    if (!data.name || !data.description) {
      console.warn(`Skill file ${filePath} missing required fields (name or description)`);
      return null;
    }

    const frontmatter = data as SkillFrontmatter;

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      location: filePath,
      content: markdownContent,
      metadata: data,
    };
  } catch (error) {
    console.warn(`Failed to read skill file ${filePath}:`, error);
    return null;
  }
}

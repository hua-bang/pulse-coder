export type { SkillInfo } from '@coder/engine';

/**
 * YAML Frontmatter 格式
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: any;
}

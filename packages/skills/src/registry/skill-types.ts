/**
 * 技能信息
 */
export interface SkillInfo {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 文件路径 */
  location: string;
  /** 完整的 Markdown 内容 */
  content: string;
  /** YAML frontmatter 数据 */
  metadata?: Record<string, any>;
}

/**
 * YAML Frontmatter 格式
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: any;
}

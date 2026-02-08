import type { SkillInfo } from './types';
import { scanSkills } from './scanner';

/**
 * 技能注册表（单例模式）
 * 在应用启动时扫描并缓存所有技能
 */
class SkillRegistry {
  private skills: Map<string, SkillInfo> = new Map();
  private initialized = false;

  /**
   * 初始化注册表，扫描并加载所有技能
   * @param cwd 工作目录
   */
  async initialize(cwd: string): Promise<void> {
    if (this.initialized) {
      console.warn('SkillRegistry already initialized');
      return;
    }

    console.log('Scanning skills...');
    const skillList = await scanSkills(cwd);

    this.skills.clear();
    for (const skill of skillList) {
      this.skills.set(skill.name, skill);
    }

    this.initialized = true;
    console.log(`Loaded ${this.skills.size} skill(s)`);
  }

  /**
   * 获取所有技能
   */
  getAll(): SkillInfo[] {
    return Array.from(this.skills.values());
  }

  /**
   * 根据名称获取技能
   * @param name 技能名称
   */
  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /**
   * 检查技能是否存在
   * @param name 技能名称
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 搜索技能（模糊匹配）
   * @param keyword 关键词
   */
  search(keyword: string): SkillInfo[] {
    const lowerKeyword = keyword.toLowerCase();
    return this.getAll().filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerKeyword) ||
        skill.description.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.skills.clear();
    this.initialized = false;
  }

  /**
   * 重新加载技能
   * @param cwd 工作目录
   */
  async reload(cwd: string): Promise<void> {
    this.clear();
    await this.initialize(cwd);
  }
}

// 导出单例实例
export const skillRegistry = new SkillRegistry();

export default skillRegistry;

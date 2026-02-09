import type { SkillProvider } from '@coder/engine';
import { SkillRegistry } from './registry/skill-registry';

export { skillPlugin } from './skill-plugin';
export { SkillRegistry } from './registry/skill-registry';
export type { SkillFrontmatter } from './registry/skill-types';

export async function createSkillProvider(cwd: string): Promise<SkillProvider> {
  const registry = new SkillRegistry();
  await registry.initialize(cwd);
  return {
    name: 'filesystem-skills',
    type: 'skill',
    skills: registry.getAll(),
  };
}

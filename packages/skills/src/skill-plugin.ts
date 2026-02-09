import type { IPlugin, IPluginContext } from '@coder/engine';
import { SkillRegistry } from './registry/skill-registry';

export const skillPlugin: IPlugin = {
  name: 'coder-skills',
  version: '1.0.0',

  async activate(context: IPluginContext) {
    const registry = new SkillRegistry();
    await registry.initialize(process.cwd());

    const skills = registry.getAll();
    context.registerSkills(skills);

    context.logger.info(`[coder-skills] Registered ${skills.length} skill(s)`);
  }
};

export default skillPlugin;
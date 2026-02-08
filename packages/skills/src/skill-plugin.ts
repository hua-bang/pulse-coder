import type { IPlugin, IExtensionContext } from '@coder/engine';
import { SkillRegistry } from './registry/skill-registry';
import generateSkillTool from './tool';

export const skillPlugin: IPlugin = {
  name: 'coder-skills',
  version: '1.0.0',
  extensions: [
    {
      type: 'skill',
      provider: new SkillRegistry()
    }
  ],

  async activate(context: IExtensionContext) {
    const registry = new SkillRegistry();
    await registry.initialize(process.cwd());

    const skills = registry.getAll();
    const skillTool = generateSkillTool(skills);
    context.registerTools('skill', skillTool);
  }
};

export default skillPlugin;
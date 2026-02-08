import type { IPlugin, IExtensionContext } from '@coder/engine';
import { SkillRegistry } from './registry/skill-registry.js';

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
    context.registerExtension('skill', registry);
  }
};

export default skillPlugin;
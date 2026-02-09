import type { IPlugin, IPluginContext, SkillProvider } from '@coder/engine';
import { generateSkillTool } from '@coder/engine';

export const skillPlugin: IPlugin = {
  name: 'coder-skills',
  version: '1.0.0',

  async activate(context: IPluginContext) {
    const providers = context.getProviders<SkillProvider>('skill');
    const allSkills = providers.flatMap((p) => p.skills);

    if (allSkills.length > 0) {
      context.registerTool(generateSkillTool(allSkills));
    }

    context.logger.info(`[coder-skills] Registered ${allSkills.length} skill(s)`);
  }
};

export default skillPlugin;

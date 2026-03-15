import { join } from 'path';
import { homedir } from 'os';
import { createDevtoolsIntegration } from 'pulse-coder-plugin-kit/devtools';

export const devtoolsIntegration = createDevtoolsIntegration({
  baseDir: join(homedir(), '.pulse-coder', 'devtools'),
  pluginName: 'devtools',
  pluginVersion: '0.1.0',
  toolName: 'devtools_run_get',
  enableTool: true,
  saveUserText: true,
});

export const devtoolsStore = devtoolsIntegration.store;
export const devtoolsPlugin = devtoolsIntegration.enginePlugin;

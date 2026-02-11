import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin.js';
import { createTaskTool } from './task.tool.js';

/**
 * Task Plugin - Provides sub-agent spawning capability.
 *
 * Registers a `task` tool that allows the main agent to delegate
 * complex subtasks to independent sub-agents. Each sub-agent runs
 * in its own context through the same agent loop.
 */
export const taskPlugin: EnginePlugin = {
  name: '@coder/engine/task',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const taskTool = createTaskTool({
      getTools: () => {
        // Dynamically collect all registered tools at invocation time,
        // so tools registered after this plugin are also available.
        const tools: Record<string, any> = {};
        // We rely on the PluginManager context to access all tools.
        // The getTool method only gets a single tool by name, so we
        // store a reference to the full tools map via a service.
        const toolsMap = context.getService<() => Record<string, any>>('getToolsMap');
        if (toolsMap) {
          return toolsMap();
        }
        return tools;
      },
    });

    context.registerTool('task', taskTool);
    context.logger?.info?.('Task plugin initialized - sub-agent capability enabled');
  },
};

export default taskPlugin;

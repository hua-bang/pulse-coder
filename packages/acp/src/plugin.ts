import type { EnginePlugin, EnginePluginContext } from './engine-types.js';

import {
  ACP_SERVICE_NAME,
  AcpBridgeService,
  AcpHttpClient,
  AcpStdioClient,
  buildClientConfigFromEnv,
  buildMultiTargetClient,
  buildStdioConfigFromEnv,
  DEFAULT_SESSION_STORE_PATH,
  DEFAULT_TARGET,
  resolveAcpTransport,
} from './client.js';
import { FileAcpSessionStore } from './session-store.js';
import { createAcpTools } from './tools.js';

export const ACP_PLUGIN_NAME = 'pulse-coder-acp';
export const ACP_PLUGIN_VERSION = '0.1.0';

export interface AcpPluginOptions {
  env?: NodeJS.ProcessEnv;
}

export function createAcpPlugin(options: AcpPluginOptions = {}): EnginePlugin {
  return {
    name: ACP_PLUGIN_NAME,
    version: ACP_PLUGIN_VERSION,
    async initialize(context: EnginePluginContext) {
      const env = options.env ?? process.env;
      const transport = resolveAcpTransport(env);
      const client = transport === 'multi'
        ? buildMultiTargetClient(env)
        : transport === 'stdio'
          ? new AcpStdioClient(buildStdioConfigFromEnv(env))
          : new AcpHttpClient(buildClientConfigFromEnv(env));

      const storePath = env.ACP_SESSION_STORE_PATH?.trim() || DEFAULT_SESSION_STORE_PATH;
      const sessionStore = new FileAcpSessionStore(storePath);
      const defaultTarget = env.ACP_DEFAULT_TARGET?.trim() || DEFAULT_TARGET;
      const service = new AcpBridgeService({
        client,
        sessionStore,
        defaultTarget,
      });

      await sessionStore.initialize();

      context.registerService(ACP_SERVICE_NAME, service);

      const tools = createAcpTools(service);
      for (const [toolName, tool] of Object.entries(tools)) {
        context.registerTool(toolName, tool);
      }

      const status = service.getStatus();
      context.logger.info(
        `[ACP] plugin ready transport=${status.transport} configured=${status.configured} baseUrl=${status.baseUrl ?? '(unset)'} command=${status.command ?? '(unset)'} targets=${status.targets?.join(',') ?? '(unset)'} configuredTargets=${status.configuredTargets?.join(',') ?? '(unset)'} defaultTarget=${status.defaultTarget}`,
      );
    },
  };
}

export default createAcpPlugin;

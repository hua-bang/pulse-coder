import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';

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
} from './client';
import { FileAcpSessionStore } from './session-store';
import { createAcpTools } from './tools';

export const builtInAcpPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-acp',
  version: '0.1.0',
  async initialize(context: EnginePluginContext) {
    const transport = resolveAcpTransport(process.env);
    const client = transport === 'multi'
      ? buildMultiTargetClient(process.env)
      : transport === 'stdio'
        ? new AcpStdioClient(buildStdioConfigFromEnv(process.env))
        : new AcpHttpClient(buildClientConfigFromEnv(process.env));

    const storePath = process.env.ACP_SESSION_STORE_PATH?.trim() || DEFAULT_SESSION_STORE_PATH;
    const sessionStore = new FileAcpSessionStore(storePath);
    const defaultTarget = process.env.ACP_DEFAULT_TARGET?.trim() || DEFAULT_TARGET;
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

export default builtInAcpPlugin;

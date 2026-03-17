import { AsyncLocalStorage } from 'async_hooks';
import type { EnginePlugin, SystemPromptOption } from 'pulse-coder-engine';
import type {
  FileVaultServiceOptions,
  VaultContext,
  VaultResolver,
  VaultResolverInput,
  VaultRunContext,
} from './types.js';
import { FileVaultPluginService } from './service.js';
import { createVaultInspectTool } from './tools.js';

const DEFAULT_PROMPT = [
  '## Vault Binding',
  'This runtime has a bound vault for the current session.',
  '- Use vault paths for artifacts, logs, and configuration.',
  '- vault.root is NOT the git worktree path; use it only for artifacts/config/logs.',
  '- If a command result suggests another vault, treat that as unexpected and return to the bound vault.',
].join('\n');

export interface CreateVaultIntegrationOptions extends FileVaultServiceOptions {
  service?: FileVaultPluginService;
  runContextAdapter?: VaultRunContextAdapter;
  pluginName?: string;
  pluginVersion?: string;
  promptHeader?: string;
  resolver?: VaultResolver;
}

export interface ResolveCurrentVaultInput {
  service: FileVaultPluginService;
  resolver?: VaultResolver;
  runContext?: VaultRunContext;
  engineRunContext?: Record<string, any>;
}

export interface GetVaultInput {
  runContext?: VaultRunContext;
  engineRunContext?: Record<string, any>;
}

export interface VaultRunContextAdapter {
  withContext<T>(context: VaultRunContext, run: () => Promise<T>): Promise<T>;
  getContext(): VaultRunContext | undefined;
}

export interface VaultIntegration {
  service: FileVaultPluginService;
  enginePlugin: EnginePlugin;
  initialize(): Promise<void>;
  withRunContext<T>(context: VaultRunContext, run: () => Promise<T>): Promise<T>;
  getRunContext(): VaultRunContext | undefined;
  getVault(input?: GetVaultInput): Promise<VaultContext | null>;
}

export async function resolveCurrentVault(
  input: ResolveCurrentVaultInput,
): Promise<VaultContext | null> {
  const resolver = input.resolver ?? defaultVaultResolver;
  const identity = await resolver({
    runContext: input.runContext,
    engineRunContext: input.engineRunContext,
  });

  if (!identity) {
    return null;
  }

  return input.service.ensureVault(identity);
}

export function createVaultIntegration(options: CreateVaultIntegrationOptions = {}): VaultIntegration {
  const {
    service,
    runContextAdapter,
    pluginName,
    pluginVersion,
    promptHeader,
    resolver,
    ...serviceOptions
  } = options;

  const vaultService = service ?? new FileVaultPluginService(serviceOptions);
  const adapter = runContextAdapter ?? createAsyncLocalRunContextAdapter();
  const enginePlugin = createVaultEnginePlugin({
    service: vaultService,
    getRunContext: () => adapter.getContext(),
    name: pluginName,
    version: pluginVersion,
    promptHeader,
    resolver,
  });

  return {
    service: vaultService,
    enginePlugin,
    initialize: () => vaultService.initialize(),
    withRunContext: (context, run) => adapter.withContext(context, run),
    getRunContext: () => adapter.getContext(),
    getVault: (input) =>
      resolveCurrentVault({
        service: vaultService,
        resolver,
        runContext: input?.runContext ?? adapter.getContext(),
        engineRunContext: input?.engineRunContext,
      }),
  };
}

export interface CreateVaultEnginePluginOptions {
  service: FileVaultPluginService;
  getRunContext: () => VaultRunContext | undefined;
  name?: string;
  version?: string;
  promptHeader?: string;
  resolver?: VaultResolver;
}

export function createVaultEnginePlugin(options: CreateVaultEnginePluginOptions): EnginePlugin {
  const pluginName = options.name ?? 'vault-binding';
  const pluginVersion = options.version ?? '0.0.1';
  const promptHeader = options.promptHeader?.trim() || DEFAULT_PROMPT;
  const resolver = options.resolver ?? defaultVaultResolver;

  return {
    name: pluginName,
    version: pluginVersion,
    async initialize(context) {
      context.registerService('vaultService', options.service);
      const inspectTool = createVaultInspectTool({
        getVault: () =>
          resolveCurrentVault({
            service: options.service,
            resolver,
            runContext: options.getRunContext(),
          }),
      });
      context.registerTools({ [inspectTool.name]: inspectTool });

      context.registerHook('beforeRun', async ({ systemPrompt, runContext }) => {
        const identity = await resolver({ runContext: options.getRunContext(), engineRunContext: runContext });
        if (!identity) {
          return;
        }

        const vault = await options.service.ensureVault(identity);
        const append = buildVaultPrompt(promptHeader, vault);
        return {
          systemPrompt: appendSystemPrompt(systemPrompt, append),
        };
      });
    },
  };
}

function defaultVaultResolver(_input: VaultResolverInput): null {
  return null;
}

function buildVaultPrompt(header: string, vault: VaultContext): string {
  return [
    header,
    `- vault.id: ${vault.id}`,
    `- vault.root: ${vault.root}`,
    `- vault.config: ${vault.configPath}`,
    `- vault.state: ${vault.statePath}`,
    `- vault.artifacts: ${vault.artifactsPath}`,
    `- vault.logs: ${vault.logsPath}`,
  ].join('\n');
}

function createAsyncLocalRunContextAdapter(): VaultRunContextAdapter {
  const store = new AsyncLocalStorage<VaultRunContext>();

  return {
    withContext<T>(context: VaultRunContext, run: () => Promise<T>): Promise<T> {
      return store.run(context, run);
    },
    getContext() {
      return store.getStore();
    },
  };
}

function appendSystemPrompt(base: SystemPromptOption | undefined, append: string): SystemPromptOption {
  const normalizedAppend = append.trim();
  if (!normalizedAppend) {
    return base ?? { append: '' };
  }

  if (!base) {
    return { append: normalizedAppend };
  }

  if (typeof base === 'string') {
    return `${base}\n\n${normalizedAppend}`;
  }

  if (typeof base === 'function') {
    return () => `${base()}\n\n${normalizedAppend}`;
  }

  const currentAppend = base.append.trim();
  return {
    append: currentAppend ? `${currentAppend}\n\n${normalizedAppend}` : normalizedAppend,
  };
}

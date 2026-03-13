import { AsyncLocalStorage } from 'async_hooks';
import type { EnginePlugin, SystemPromptOption } from 'pulse-coder-engine';
import type {
  FileWorkspaceServiceOptions,
  WorkspaceContext,
  WorkspaceResolver,
  WorkspaceResolverInput,
  WorkspaceRunContext,
} from './types.js';
import { FileWorkspacePluginService } from './service.js';

const DEFAULT_PROMPT = [
  '## Workspace Binding',
  'This runtime has a bound workspace for the current session.',
  '- Use workspace paths for artifacts, logs, and configuration.',
  '- If a command result suggests another workspace, treat that as unexpected and return to the bound workspace.',
].join('\n');

export interface CreateWorkspaceIntegrationOptions extends FileWorkspaceServiceOptions {
  service?: FileWorkspacePluginService;
  runContextAdapter?: WorkspaceRunContextAdapter;
  pluginName?: string;
  pluginVersion?: string;
  promptHeader?: string;
  resolver?: WorkspaceResolver;
}

export interface WorkspaceRunContextAdapter {
  withContext<T>(context: WorkspaceRunContext, run: () => Promise<T>): Promise<T>;
  getContext(): WorkspaceRunContext | undefined;
}

export interface WorkspaceIntegration {
  service: FileWorkspacePluginService;
  enginePlugin: EnginePlugin;
  initialize(): Promise<void>;
  withRunContext<T>(context: WorkspaceRunContext, run: () => Promise<T>): Promise<T>;
  getRunContext(): WorkspaceRunContext | undefined;
}

export function createWorkspaceIntegration(options: CreateWorkspaceIntegrationOptions = {}): WorkspaceIntegration {
  const {
    service,
    runContextAdapter,
    pluginName,
    pluginVersion,
    promptHeader,
    resolver,
    ...serviceOptions
  } = options;

  const workspaceService = service ?? new FileWorkspacePluginService(serviceOptions);
  const adapter = runContextAdapter ?? createAsyncLocalRunContextAdapter();
  const enginePlugin = createWorkspaceEnginePlugin({
    service: workspaceService,
    getRunContext: () => adapter.getContext(),
    name: pluginName,
    version: pluginVersion,
    promptHeader,
    resolver,
  });

  return {
    service: workspaceService,
    enginePlugin,
    initialize: () => workspaceService.initialize(),
    withRunContext: (context, run) => adapter.withContext(context, run),
    getRunContext: () => adapter.getContext(),
  };
}

export interface CreateWorkspaceEnginePluginOptions {
  service: FileWorkspacePluginService;
  getRunContext: () => WorkspaceRunContext | undefined;
  name?: string;
  version?: string;
  promptHeader?: string;
  resolver?: WorkspaceResolver;
}

export function createWorkspaceEnginePlugin(options: CreateWorkspaceEnginePluginOptions): EnginePlugin {
  const pluginName = options.name ?? 'workspace-binding';
  const pluginVersion = options.version ?? '0.0.1';
  const promptHeader = options.promptHeader?.trim() || DEFAULT_PROMPT;
  const resolver = options.resolver ?? defaultWorkspaceResolver;

  return {
    name: pluginName,
    version: pluginVersion,
    async initialize(context) {
      context.registerService('workspaceService', options.service);

      context.registerHook('beforeRun', async ({ systemPrompt, runContext }) => {
        const identity = await resolver({ runContext: options.getRunContext(), engineRunContext: runContext });
        if (!identity) {
          return;
        }

        const workspace = await options.service.ensureWorkspace(identity);
        const append = buildWorkspacePrompt(promptHeader, workspace);
        return {
          systemPrompt: appendSystemPrompt(systemPrompt, append),
        };
      });
    },
  };
}

function defaultWorkspaceResolver(_input: WorkspaceResolverInput): null {
  return null;
}

function buildWorkspacePrompt(header: string, workspace: WorkspaceContext): string {
  return [
    header,
    `- workspace.id: ${workspace.id}`,
    `- workspace.root: ${workspace.root}`,
    `- workspace.config: ${workspace.configPath}`,
    `- workspace.state: ${workspace.statePath}`,
    `- workspace.artifacts: ${workspace.artifactsPath}`,
    `- workspace.logs: ${workspace.logsPath}`,
  ].join('\n');
}

function createAsyncLocalRunContextAdapter(): WorkspaceRunContextAdapter {
  const store = new AsyncLocalStorage<WorkspaceRunContext>();

  return {
    withContext<T>(context: WorkspaceRunContext, run: () => Promise<T>): Promise<T> {
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

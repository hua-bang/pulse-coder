import { AsyncLocalStorage } from 'async_hooks';
import type { EnginePlugin, SystemPromptOption } from 'pulse-coder-engine';
import type { FileWorktreeServiceOptions, UpsertWorktreeInput, WorktreeBindingView, WorktreeScope } from './types.js';
import { FileWorktreePluginService } from './service.js';

const DEFAULT_PROMPT = [
  '## Git Worktree Binding',
  'This runtime has a bound git worktree for the current session.',
  '- Always run git, build, and file-editing commands in the bound worktree path.',
  '- If a command result suggests another directory, treat that as unexpected and return to the bound worktree.',
  '- Before major operations, validate context with `pwd && git branch --show-current && git status -sb`.',
].join('\n');

export interface WorktreeRunContext {
  runtimeKey: string;
  scopeKey: string;
}

export interface WorktreeRunContextAdapter {
  withContext<T>(context: WorktreeRunContext, run: () => Promise<T>): Promise<T>;
  getContext(): WorktreeRunContext | undefined;
}

export interface CreateWorktreeIntegrationOptions extends FileWorktreeServiceOptions {
  service?: FileWorktreePluginService;
  runContextAdapter?: WorktreeRunContextAdapter;
  pluginName?: string;
  pluginVersion?: string;
  promptHeader?: string;
}

export interface CreateWorktreeEnginePluginOptions {
  service: FileWorktreePluginService;
  getRunContext: () => WorktreeRunContext | undefined;
  name?: string;
  version?: string;
  promptHeader?: string;
}

export interface WorktreeIntegration {
  service: FileWorktreePluginService;
  enginePlugin: EnginePlugin;
  initialize(): Promise<void>;
  withRunContext<T>(context: WorktreeRunContext, run: () => Promise<T>): Promise<T>;
  getRunContext(): WorktreeRunContext | undefined;
}

export interface SetWorktreeBindingInput extends UpsertWorktreeInput {
  runtimeKey: string;
  scopeKey: string;
}

export function createWorktreeIntegration(options: CreateWorktreeIntegrationOptions = {}): WorktreeIntegration {
  const {
    service,
    runContextAdapter,
    pluginName,
    pluginVersion,
    promptHeader,
    ...serviceOptions
  } = options;

  const worktreeService = service ?? new FileWorktreePluginService(serviceOptions);
  const adapter = runContextAdapter ?? createAsyncLocalRunContextAdapter();
  const enginePlugin = createWorktreeEnginePlugin({
    service: worktreeService,
    getRunContext: () => adapter.getContext(),
    name: pluginName,
    version: pluginVersion,
    promptHeader,
  });

  return {
    service: worktreeService,
    enginePlugin,
    initialize: () => worktreeService.initialize(),
    withRunContext: (context, run) => adapter.withContext(context, run),
    getRunContext: () => adapter.getContext(),
  };
}

export function createWorktreeEnginePlugin(options: CreateWorktreeEnginePluginOptions): EnginePlugin {
  const pluginName = options.name ?? 'git-worktree-binding';
  const pluginVersion = options.version ?? '0.0.1';
  const promptHeader = options.promptHeader?.trim() || DEFAULT_PROMPT;

  return {
    name: pluginName,
    version: pluginVersion,
    async initialize(context) {
      context.registerService('worktreeService', options.service);

      context.registerHook('beforeRun', async ({ systemPrompt }) => {
        const runContext = options.getRunContext();
        if (!runContext) {
          return;
        }

        const binding = await options.service.getScopeBinding(toScope(runContext));
        if (!binding) {
          return;
        }

        const append = buildBindingPrompt(promptHeader, binding);
        return {
          systemPrompt: appendSystemPrompt(systemPrompt, append),
        };
      });
    },
  };
}

export async function setWorktreeBinding(
  service: FileWorktreePluginService,
  input: SetWorktreeBindingInput,
): Promise<WorktreeBindingView> {
  const scope = toScope(input);
  return service.upsertAndBind(scope, {
    id: input.id,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
  });
}

export async function clearWorktreeBinding(
  service: FileWorktreePluginService,
  scope: WorktreeRunContext,
): Promise<boolean> {
  const result = await service.clearScopeBinding(toScope(scope));
  return result.ok;
}

function toScope(input: WorktreeRunContext): WorktreeScope {
  return {
    runtimeKey: input.runtimeKey,
    scopeKey: input.scopeKey,
  };
}

function buildBindingPrompt(header: string, binding: WorktreeBindingView): string {
  const lines = [
    header,
    `- worktree.id: ${binding.worktree.id}`,
    `- repo.root: ${binding.worktree.repoRoot}`,
    `- worktree.path: ${binding.worktree.worktreePath}`,
  ];

  if (binding.worktree.branch) {
    lines.push(`- git.branch: ${binding.worktree.branch}`);
  }

  return lines.join('\n');
}

function createAsyncLocalRunContextAdapter(): WorktreeRunContextAdapter {
  const store = new AsyncLocalStorage<WorktreeRunContext>();

  return {
    withContext<T>(context: WorktreeRunContext, run: () => Promise<T>): Promise<T> {
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

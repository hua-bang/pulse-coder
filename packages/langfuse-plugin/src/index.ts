import { randomUUID } from 'crypto';
import { Langfuse } from 'langfuse';

import type {
  EnginePlugin,
  EnginePluginContext,
} from 'pulse-coder-engine';
import type { Context } from 'pulse-coder-engine';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LangfusePluginOptions {
  /** Langfuse public key. Defaults to LANGFUSE_PUBLIC_KEY env var. */
  publicKey?: string;
  /** Langfuse secret key. Defaults to LANGFUSE_SECRET_KEY env var. */
  secretKey?: string;
  /** Langfuse host URL. Defaults to LANGFUSE_HOST env var or cloud. */
  baseUrl?: string;
  /** Plugin name (shown in PluginManager). Default: 'langfuse'. */
  pluginName?: string;
  /** Plugin version. Default: '0.1.0'. */
  pluginVersion?: string;
  /**
   * Release tag attached to every trace (e.g. git sha). Defaults to
   * LANGFUSE_RELEASE env var if set.
   */
  release?: string;
  /** Environment tag (e.g. 'prod', 'dev'). Defaults to NODE_ENV. */
  environment?: string;
  /** Extra static tags appended to every trace. */
  tags?: string[];
  /**
   * If set to true, disables the plugin entirely (useful when keys are
   * missing in dev). Default: auto-disable when no publicKey/secretKey.
   */
  disabled?: boolean;
  /**
   * Whether to include the user's input text in trace input.
   * Default: true. Set false for PII-sensitive deployments.
   */
  saveUserText?: boolean;
  /**
   * Whether to include full LLM output text on the generation.
   * Default: true.
   */
  saveLLMOutput?: boolean;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  trace: any;
  /** Current in-flight LLM generation, if any. */
  currentGeneration?: any;
  /** Active tool spans keyed by tool name (last-wins; tools rarely nest). */
  toolSpans: Map<string, any>;
}

const stateByContext = new WeakMap<Context, RunState>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRunId(input: { runContext?: Record<string, any> }): string {
  const existing = input.runContext?.runId;
  if (existing) return String(existing);
  const generated = randomUUID();
  if (input.runContext) input.runContext.runId = generated;
  return generated;
}

function systemPromptToString(sp: unknown): string | undefined {
  if (!sp) return undefined;
  if (typeof sp === 'string') return sp;
  if (typeof sp === 'function') {
    try { return String((sp as () => string)()); } catch { return undefined; }
  }
  if (typeof sp === 'object' && sp !== null) {
    const append = (sp as any).append;
    if (typeof append === 'string') return append;
  }
  return undefined;
}

function normalizeUsage(usage: any): any {
  if (!usage || typeof usage !== 'object') return undefined;
  // Langfuse accepts { input, output, total } or OpenAI shape.
  return {
    input: usage.inputTokens ?? usage.promptTokens ?? usage.input,
    output: usage.outputTokens ?? usage.completionTokens ?? usage.output,
    total: usage.totalTokens ?? usage.total,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLangfusePlugin(options: LangfusePluginOptions = {}): EnginePlugin {
  const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = options.baseUrl ?? process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASEURL;
  const release = options.release ?? process.env.LANGFUSE_RELEASE;
  const environment = options.environment ?? process.env.NODE_ENV;
  const staticTags = options.tags ?? [];
  const saveUserText = options.saveUserText !== false;
  const saveLLMOutput = options.saveLLMOutput !== false;

  const disabled = options.disabled ?? (!publicKey || !secretKey);

  const pluginName = options.pluginName ?? 'langfuse';
  const pluginVersion = options.pluginVersion ?? '0.1.0';

  let lf: Langfuse | undefined;

  const plugin: EnginePlugin = {
    name: pluginName,
    version: pluginVersion,

    async initialize(ctx: EnginePluginContext) {
      const log = ctx.logger;

      if (disabled) {
        log.warn(
          '[langfuse] plugin disabled (missing LANGFUSE_PUBLIC_KEY/SECRET_KEY). ' +
          'No traces will be sent.',
        );
        return;
      }

      lf = new Langfuse({
        publicKey: publicKey!,
        secretKey: secretKey!,
        baseUrl,
        release,
      });

      ctx.registerService('langfuse', lf);

      // -------- beforeRun: create trace --------
      ctx.registerHook('beforeRun', (input) => {
        if (!lf) return;
        const runId = resolveRunId(input);
        const runCtx = input.runContext ?? {};

        const userText =
          saveUserText && typeof runCtx.userText === 'string'
            ? runCtx.userText
            : undefined;

        const tags = [...staticTags];
        if (runCtx.platformKey) tags.push(`platform:${runCtx.platformKey}`);
        if (runCtx.caller) tags.push(`caller:${runCtx.caller}`);

        const trace = lf.trace({
          id: runId,
          name: typeof runCtx.caller === 'string' ? runCtx.caller : 'agent-run',
          userId:
            typeof runCtx.userId === 'string' ? runCtx.userId : undefined,
          sessionId:
            typeof runCtx.sessionId === 'string' ? runCtx.sessionId : undefined,
          input: userText,
          metadata: {
            platformKey: runCtx.platformKey,
            channelKind: runCtx.channelKind,
            channelId: runCtx.channelId,
            vaultId: runCtx.vaultId,
            callerSelectors: runCtx.callerSelectors,
            environment,
          },
          tags: tags.length ? tags : undefined,
          release,
        });

        stateByContext.set(input.context, {
          runId,
          trace,
          toolSpans: new Map(),
        });
      });

      // -------- beforeLLMCall: start generation --------
      ctx.registerHook('beforeLLMCall', (input) => {
        const state = stateByContext.get(input.context);
        if (!state) return;

        const systemPrompt = systemPromptToString(input.systemPrompt);
        const messages = input.context?.messages ?? [];

        state.currentGeneration = state.trace.generation({
          name: 'llm-call',
          startTime: new Date(),
          input: systemPrompt
            ? [{ role: 'system', content: systemPrompt }, ...messages]
            : messages,
          metadata: {
            toolNames: Object.keys(input.tools ?? {}),
          },
        });
      });

      // -------- afterLLMCall: end generation --------
      ctx.registerHook('afterLLMCall', (input) => {
        const state = stateByContext.get(input.context);
        if (!state?.currentGeneration) return;

        state.currentGeneration.end({
          endTime: new Date(),
          output: saveLLMOutput ? input.text : undefined,
          usage: normalizeUsage(input.usage),
          metadata: {
            finishReason: input.finishReason,
            timings: input.timings,
          },
        });
        state.currentGeneration = undefined;
      });

      // -------- beforeToolCall: start span --------
      ctx.registerHook('beforeToolCall', (input) => {
        if (!input.context) return;
        const state = stateByContext.get(input.context);
        if (!state) return;

        const span = state.trace.span({
          name: `tool:${input.name}`,
          startTime: new Date(),
          input: input.input,
        });
        state.toolSpans.set(input.name, span);
      });

      // -------- afterToolCall: end span --------
      ctx.registerHook('afterToolCall', (input) => {
        if (!input.context) return;
        const state = stateByContext.get(input.context);
        if (!state) return;

        const span = state.toolSpans.get(input.name);
        if (!span) return;

        span.end({
          endTime: new Date(),
          output: input.output,
        });
        state.toolSpans.delete(input.name);
      });

      // -------- onCompacted: record event --------
      ctx.registerHook('onCompacted', (input) => {
        const state = stateByContext.get(input.context);
        if (!state) return;

        state.trace.event({
          name: 'context-compacted',
          startTime: new Date(),
          metadata: input.event,
        });
      });

      // -------- afterRun: finalize trace --------
      ctx.registerHook('afterRun', async (input) => {
        const state = stateByContext.get(input.context);
        if (!state) return;

        // Clean up any dangling generation/spans (defensive).
        if (state.currentGeneration) {
          try { state.currentGeneration.end({ endTime: new Date() }); } catch {}
        }
        for (const span of state.toolSpans.values()) {
          try { span.end({ endTime: new Date() }); } catch {}
        }
        state.toolSpans.clear();

        state.trace.update({ output: input.result });
        stateByContext.delete(input.context);

        // Flush so short-lived processes (cron, serverless) don't drop data.
        try {
          await lf?.flushAsync();
        } catch (err) {
          log.warn('[langfuse] flushAsync failed', err as any);
        }
      });

      log.info(`[langfuse] plugin initialized (baseUrl=${baseUrl ?? 'default'})`);
    },

    async destroy() {
      try {
        await lf?.shutdownAsync();
      } catch {
        // ignore
      }
    },
  };

  return plugin;
}

export default createLangfusePlugin;

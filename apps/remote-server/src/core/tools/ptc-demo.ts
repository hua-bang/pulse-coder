import z from 'zod';
import type { Tool, ToolExecutionContext } from 'pulse-coder-engine';

const toolSchema = z.object({
  message: z.string().optional().describe('Optional message echoed in response.'),
});

type DemoInput = z.infer<typeof toolSchema>;

interface DemoResult {
  ok: true;
  tool: string;
  message: string;
  caller?: string;
  callerSelectors: string[];
  platformKey?: string;
  note: string;
}

function resolveSelectors(context?: ToolExecutionContext): string[] {
  const selectors = context?.runContext?.callerSelectors;
  if (typeof selectors === 'string') {
    return [selectors];
  }
  if (Array.isArray(selectors)) {
    return selectors.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function buildDemoTool(
  name: string,
  description: string,
  note: string,
  allowedCallers?: string[],
  deferLoading?: boolean,
): Tool<DemoInput, DemoResult> {
  return {
    name,
    description,
    inputSchema: toolSchema,
    allowed_callers: allowedCallers,
    ...(deferLoading ? { defer_loading: true } : {}),
    execute: async (input, context) => {
      const callerSelectors = resolveSelectors(context);
      const caller = typeof context?.runContext?.caller === 'string' ? context.runContext.caller : undefined;
      const platformKey = typeof context?.runContext?.platformKey === 'string' ? context.runContext.platformKey : undefined;

      return {
        ok: true,
        tool: name,
        message: input.message?.trim() || 'PTC demo success',
        caller,
        callerSelectors,
        platformKey,
        note,
      };
    },
  };
}

export const ptcDemoCallerProbeTool = buildDemoTool(
  'ptc_demo_caller_probe',
  'Inspect caller selectors in runContext for PTC demo.',
  'Unrestricted tool. Always callable if exposed by normal tool registration.',
  undefined,
  true,
);

export const ptcDemoCallerOnlyTool = buildDemoTool(
  'ptc_demo_caller_only',
  'PTC demo tool that is only available when called by ptc_demo_caller_probe.',
  'Restricted by allowed_callers=["ptc_demo_caller_probe"].',
  ['ptc_demo_caller_probe'],
);

export const ptcDemoCronOnlyTool = buildDemoTool(
  'ptc_demo_cron_only',
  'PTC demo tool that is only available when called by cron_job.',
  'Restricted by allowed_callers=["cron_job"].',
  ['cron_job'],
);

export const ptcDemoDeferredOnlyTool = buildDemoTool(
  'ptc_demo_deferred_only',
  'PTC demo tool that is only available when called by deferred_demo.',
  'Restricted by allowed_callers=["deferred_demo"].',
  ['deferred_demo'],
);

export const ptcDemoTools: Record<string, Tool> = {
  ptc_demo_caller_probe: ptcDemoCallerProbeTool,
  ptc_demo_caller_only: ptcDemoCallerOnlyTool,
  ptc_demo_cron_only: ptcDemoCronOnlyTool,
  ptc_demo_deferred_only: ptcDemoDeferredOnlyTool,
};

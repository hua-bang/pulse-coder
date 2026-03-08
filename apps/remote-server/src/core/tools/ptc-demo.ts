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
): Tool<DemoInput, DemoResult> {
  return {
    name,
    description,
    inputSchema: toolSchema,
    allowed_callers: allowedCallers,
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
);

export const ptcDemoDiscordOnlyTool = buildDemoTool(
  'ptc_demo_discord_only',
  'PTC demo tool that is only available to Discord callers.',
  'Restricted by allowed_callers=["platform:discord"].',
  ['platform:discord'],
);

export const ptcDemoFeishuOnlyTool = buildDemoTool(
  'ptc_demo_feishu_only',
  'PTC demo tool that is only available to Feishu callers.',
  'Restricted by allowed_callers=["platform:feishu"].',
  ['platform:feishu'],
);

export const ptcDemoInternalOnlyTool = buildDemoTool(
  'ptc_demo_internal_only',
  'PTC demo tool that is only available to internal callers.',
  'Restricted by allowed_callers=["platform:internal"].',
  ['platform:internal'],
);

export const ptcDemoGroupOnlyTool = buildDemoTool(
  'ptc_demo_group_only',
  'PTC demo tool that is only available in group-like channels.',
  'Restricted by allowed_callers=["kind:group", "kind:channel"].',
  ['kind:group', 'kind:channel'],
);

export const ptcDemoTools: Record<string, Tool> = {
  ptc_demo_caller_probe: ptcDemoCallerProbeTool,
  ptc_demo_discord_only: ptcDemoDiscordOnlyTool,
  ptc_demo_feishu_only: ptcDemoFeishuOnlyTool,
  ptc_demo_internal_only: ptcDemoInternalOnlyTool,
  ptc_demo_group_only: ptcDemoGroupOnlyTool,
};

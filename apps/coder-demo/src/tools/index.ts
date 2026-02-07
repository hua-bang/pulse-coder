import ReadTool from './read';
import WriteTool from './write';
import LsTool from './ls';
import BashTool from './bash';
import TavilyTool from './tavily';
import { createSkillTool } from './skill';
import type { Tool } from '../typings';

/** Static tools that don't depend on runtime initialization */
const StaticTools = [
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
] as const;

/**
 * Build the full tool list. Must be called after skillRegistry.initialize()
 * so the skill tool can read from the populated registry.
 */
export function buildTools(): Tool[] {
  return [
    ...StaticTools,
    createSkillTool(),
  ];
}

export {
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
  createSkillTool,
};

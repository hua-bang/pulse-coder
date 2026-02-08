import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { LsTool } from './ls.js';
import { BashTool } from './bash.js';
import { TavilyTool } from './tavily.js';
import { SkillTool } from './skill.js';

export const BuiltinTools = [
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
  SkillTool,
] as const;

export const BuiltinToolsMap = BuiltinTools.reduce((acc, toolInstance) => {
  acc[toolInstance.name] = toolInstance;
  return acc;
}, {} as Record<string, any>);

export {
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
  SkillTool,
};

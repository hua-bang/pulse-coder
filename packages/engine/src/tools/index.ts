import { ReadTool } from './read';
import { WriteTool } from './write';
import { LsTool } from './ls';
import { BashTool } from './bash';
import { TavilyTool } from './tavily';
// import { SkillTool } from './skill;

export const BuiltinTools = [
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
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
};

import { ReadTool } from './read';
import { WriteTool } from './write';
import { LsTool } from './ls';
import { BashTool } from './bash';
import { TavilyTool } from './tavily';
import { Tool } from 'ai';
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

export const getFinalToolsMap = (customTools?: Record<string, Tool>) => {
  if (!customTools) {
    return BuiltinToolsMap;
  }
  return { ...BuiltinToolsMap, ...customTools };
};

export {
  ReadTool,
  WriteTool,
  LsTool,
  BashTool,
  TavilyTool,
};

import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import { BashTool } from './bash';
import { TavilyTool } from './tavily';
import { ClarifyTool } from './clarify';
import { Tool } from 'ai';
// import { SkillTool } from './skill;

export const BuiltinTools = [
  ReadTool,
  WriteTool,
  EditTool,
  GrepTool,
  LsTool,
  BashTool,
  TavilyTool,
  ClarifyTool,
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
  EditTool,
  GrepTool,
  LsTool,
  BashTool,
  TavilyTool,
  ClarifyTool,
};

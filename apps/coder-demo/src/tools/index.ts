import ReadTool from './read';
import WriteTool from './write';
import LsTool from './ls';

const BuiltinTools = [ReadTool, WriteTool, LsTool] as const;

export { ReadTool, WriteTool, LsTool, BuiltinTools };

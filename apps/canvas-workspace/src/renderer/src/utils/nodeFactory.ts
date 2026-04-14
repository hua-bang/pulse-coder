import type { CanvasNode, FileNodeData, TerminalNodeData, FrameNodeData, AgentNodeData, TextNodeData, IframeNodeData } from '../types';

let nodeIdCounter = 0;
export const genId = (): string => `node-${Date.now()}-${++nodeIdCounter}`;

const NODE_DEFAULTS: Record<CanvasNode['type'], { title: string; width: number; height: number }> = {
  file:     { title: 'Untitled', width: 420, height: 360 },
  terminal: { title: 'Terminal', width: 480, height: 300 },
  frame:    { title: 'Frame',    width: 600, height: 400 },
  agent:    { title: 'Agent',    width: 520, height: 380 },
  text:     { title: 'Text',     width: 260, height: 120 },
  iframe:   { title: 'Web',      width: 520, height: 400 },
};

export const createNodeData = (type: CanvasNode['type']): FileNodeData | TerminalNodeData | FrameNodeData | AgentNodeData | TextNodeData | IframeNodeData => {
  switch (type) {
    case 'file':     return { filePath: '', content: '', saved: false, modified: false };
    case 'terminal': return { sessionId: '' };
    case 'frame':    return { color: '#9575d4' };
    case 'agent':    return { sessionId: '', agentType: 'claude-code', status: 'idle' };
    case 'text':     return { content: '', textColor: '#1f2328', backgroundColor: 'transparent', fontSize: 18, autoSize: true };
    case 'iframe':   return { url: '' };
  }
};

export const createDefaultNode = (type: CanvasNode['type'], x: number, y: number): CanvasNode => {
  const def = NODE_DEFAULTS[type];
  return {
    id: genId(),
    type,
    title: def.title,
    x,
    y,
    width: def.width,
    height: def.height,
    data: createNodeData(type),
  };
};

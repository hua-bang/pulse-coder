import type { CanvasNode, FileNodeData, TerminalNodeData, FrameNodeData, GroupNodeData, AgentNodeData, TextNodeData, IframeNodeData, ImageNodeData, ShapeNodeData, MindmapNodeData, MindmapTopic } from '../types';

let nodeIdCounter = 0;
export const genId = (): string => `node-${Date.now()}-${++nodeIdCounter}`;

let topicIdCounter = 0;
export const genTopicId = (): string => `topic-${Date.now()}-${++topicIdCounter}`;

const NODE_DEFAULTS: Record<CanvasNode['type'], { title: string; width: number; height: number }> = {
  file:     { title: 'Untitled', width: 420, height: 360 },
  terminal: { title: 'Terminal', width: 480, height: 300 },
  frame:    { title: 'Frame',    width: 600, height: 400 },
  group:    { title: 'Group',    width: 360, height: 240 },
  agent:    { title: 'Coding Agent', width: 520, height: 920 },
  text:     { title: 'Text',     width: 260, height: 120 },
  iframe:   { title: 'Web',      width: 520, height: 400 },
  image:    { title: 'Image',    width: 320, height: 240 },
  shape:    { title: 'Shape',    width: 200, height: 140 },
  mindmap:  { title: 'Mindmap',  width: 640, height: 420 },
};

/** Default width/height for a node type — single source of truth so
 *  callers that need to center a new node on the viewport derive the
 *  offset from the same numbers `createDefaultNode` will assign. */
export const getNodeDefaultSize = (
  type: CanvasNode['type'],
): { width: number; height: number } => {
  const def = NODE_DEFAULTS[type];
  return { width: def.width, height: def.height };
};

/** Human-readable type names used for toast feedback after adding a
 *  node. Kept aligned with the FloatingToolbar button labels so the
 *  user sees the same word in the toolbar tooltip and in the toast. */
export const NODE_TYPE_LABELS: Record<CanvasNode['type'], string> = {
  file:     'Note',
  terminal: 'Terminal',
  frame:    'Frame',
  group:    'Group',
  agent:    'Coding agent',
  text:     'Text',
  iframe:   'Web page',
  image:    'Image',
  shape:    'Shape',
  mindmap:  'Mindmap',
};

export const createNodeData = (type: CanvasNode['type']): FileNodeData | TerminalNodeData | FrameNodeData | GroupNodeData | AgentNodeData | TextNodeData | IframeNodeData | ImageNodeData | ShapeNodeData | MindmapNodeData => {
  switch (type) {
    case 'file':     return { filePath: '', content: '', saved: false, modified: false };
    case 'terminal': return { sessionId: '' };
    case 'frame':    return { color: '#9575d4' };
    case 'group':    return { color: '#A594E0', childIds: [] };
    case 'agent':    return { sessionId: '', agentType: 'claude-code', status: 'idle' };
    case 'text':     return { content: '', textColor: '#1f2328', backgroundColor: 'transparent', fontSize: 18, autoSize: true };
    case 'iframe':   return { url: '', html: '', mode: 'url', prompt: '' };
    case 'image':    return { filePath: '' };
    case 'shape':    return { kind: 'rect', fill: '#E8EEF7', stroke: '#5B7CBF', strokeWidth: 2 };
    case 'mindmap':  return {
      root: {
        id: genTopicId(),
        text: 'Central topic',
        children: [
          { id: genTopicId(), text: 'Idea 1', children: [] },
          { id: genTopicId(), text: 'Idea 2', children: [] },
          { id: genTopicId(), text: 'Idea 3', children: [] },
        ],
      },
      layout: 'right',
      rev: 0,
    };
  }
};

/**
 * Deep-clone a mindmap topic tree, minting fresh ids so the result can
 * coexist with the source (duplicate / paste flows). `text`, `color`,
 * and `collapsed` are copied verbatim.
 */
export const cloneMindmapTopic = (topic: MindmapTopic): MindmapTopic => ({
  id: genTopicId(),
  text: topic.text,
  color: topic.color,
  collapsed: topic.collapsed,
  children: topic.children.map(cloneMindmapTopic),
});

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

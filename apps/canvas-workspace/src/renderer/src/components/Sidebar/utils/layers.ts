import type { CanvasNode } from '../../../types';

export interface LayerTreeNode {
  node: CanvasNode;
  children: CanvasNode[];
}

const isInsideFrame = (node: CanvasNode, frame: CanvasNode): boolean => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return (
    cx >= frame.x &&
    cx <= frame.x + frame.width &&
    cy >= frame.y &&
    cy <= frame.y + frame.height
  );
};

/** Build a tree: frames contain non-frame nodes whose center is inside them. */
export const buildLayerTree = (nodes: CanvasNode[]): LayerTreeNode[] => {
  const frames = nodes.filter((n) => n.type === 'frame');
  const nonFrames = nodes.filter((n) => n.type !== 'frame');

  const childrenOf = new Map<string, CanvasNode[]>();
  const assigned = new Set<string>();

  for (const frame of frames) {
    const kids: CanvasNode[] = [];
    for (const n of nonFrames) {
      if (!assigned.has(n.id) && isInsideFrame(n, frame)) {
        kids.push(n);
        assigned.add(n.id);
      }
    }
    childrenOf.set(frame.id, kids);
  }

  const tree: LayerTreeNode[] = [];
  for (const frame of frames) {
    tree.push({ node: frame, children: childrenOf.get(frame.id) || [] });
  }
  for (const n of nonFrames) {
    if (!assigned.has(n.id)) {
      tree.push({ node: n, children: [] });
    }
  }
  return tree;
};

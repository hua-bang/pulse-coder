import type { CanvasNode } from '../../../types';
import { computeParentFrameMap } from '../../../utils/frameHierarchy';

export interface LayerTreeNode {
  node: CanvasNode;
  children: LayerTreeNode[];
}

/**
 * Build a recursive tree. Each node is nested under its most-specific
 * containing frame (see `computeParentFrameMap`). Frames may contain both
 * regular nodes AND other frames.
 */
export const buildLayerTree = (nodes: CanvasNode[]): LayerTreeNode[] => {
  const parentMap = computeParentFrameMap(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  // Preserve the input ordering by walking `nodes` when grouping children.
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    const key = parentMap.get(n.id) ?? null;
    const arr = childrenOf.get(key);
    if (arr) arr.push(n.id);
    else childrenOf.set(key, [n.id]);
  }

  const buildNode = (id: string): LayerTreeNode => {
    const node = byId.get(id)!;
    const childIds = childrenOf.get(id) ?? [];
    return { node, children: childIds.map(buildNode) };
  };

  const rootIds = childrenOf.get(null) ?? [];
  return rootIds.map(buildNode);
};

/** Walk a layer tree and collect every frame id (including nested frames). */
export const collectFrameIds = (tree: LayerTreeNode[]): string[] => {
  const out: string[] = [];
  const walk = (nodes: LayerTreeNode[]) => {
    for (const n of nodes) {
      if (n.node.type === 'frame') out.push(n.node.id);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(tree);
  return out;
};

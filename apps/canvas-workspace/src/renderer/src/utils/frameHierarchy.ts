import type { CanvasNode } from '../types';

/** True when a node's center point falls inside a frame's bounding box. */
export const isInsideFrame = (node: CanvasNode, frame: CanvasNode): boolean => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return (
    cx >= frame.x &&
    cx <= frame.x + frame.width &&
    cy >= frame.y &&
    cy <= frame.y + frame.height
  );
};

const frameArea = (frame: CanvasNode) => frame.width * frame.height;

/**
 * For each node, find its parent frame — the smallest (by area) frame whose
 * bounding box contains the node's center. Returns a map of nodeId → parent
 * frameId (or null for root-level nodes).
 *
 * When `n` is itself a frame, a candidate frame `f` can only be its parent if
 * `f` is strictly "bigger" than `n` in the total order (area desc, then id
 * asc). This guarantees acyclic parenthood even when two frames share a bbox.
 */
export const computeParentFrameMap = (
  nodes: CanvasNode[]
): Map<string, string | null> => {
  const frames = nodes.filter((n) => n.type === 'frame');
  const map = new Map<string, string | null>();

  for (const n of nodes) {
    let best: CanvasNode | null = null;
    let bestArea = Infinity;
    const nArea = n.type === 'frame' ? frameArea(n) : -1;

    for (const f of frames) {
      if (f.id === n.id) continue;
      if (!isInsideFrame(n, f)) continue;

      const fArea = frameArea(f);
      // For frame-in-frame, require strict "bigger" ancestor to avoid cycles.
      if (n.type === 'frame') {
        if (fArea < nArea) continue;
        if (fArea === nArea && f.id >= n.id) continue;
      }

      if (fArea < bestArea) {
        best = f;
        bestArea = fArea;
      } else if (fArea === bestArea && best && f.id < best.id) {
        best = f;
      }
    }

    map.set(n.id, best ? best.id : null);
  }

  return map;
};

/**
 * Collect all transitive descendants of a frame (nodes whose parent chain
 * passes through `frameId`). Does NOT include the frame itself.
 */
export const collectFrameDescendants = (
  frameId: string,
  nodes: CanvasNode[]
): CanvasNode[] => {
  const parentMap = computeParentFrameMap(nodes);
  const result: CanvasNode[] = [];

  for (const n of nodes) {
    if (n.id === frameId) continue;
    let cur = parentMap.get(n.id) ?? null;
    while (cur) {
      if (cur === frameId) {
        result.push(n);
        break;
      }
      cur = parentMap.get(cur) ?? null;
    }
  }

  return result;
};

/**
 * Compute the nesting depth of each frame (root frames = 0, frame inside a
 * root frame = 1, and so on). Non-frames are not included in the result.
 */
export const computeFrameDepths = (nodes: CanvasNode[]): Map<string, number> => {
  const parentMap = computeParentFrameMap(nodes);
  const depths = new Map<string, number>();

  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const parent = parentMap.get(id) ?? null;
    const d = parent ? depthOf(parent) + 1 : 0;
    depths.set(id, d);
    return d;
  };

  for (const n of nodes) {
    if (n.type === 'frame') depthOf(n.id);
  }

  return depths;
};

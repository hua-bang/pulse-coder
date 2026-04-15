import { useCallback, useRef, useState } from 'react';
import type { CanvasEdge, CanvasNode } from '../types';

const MAX_HISTORY = 100;

/**
 * Combined snapshot of everything the canvas considers undoable state.
 * Both nodes and edges share a single history stack so one `undo` reverses
 * e.g. "created node + auto-bent a connected edge" as a single step, and so
 * deleting a node (which degrades bound edges to free points) can be undone
 * atomically.
 */
export interface CanvasSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const EMPTY_SNAPSHOT: CanvasSnapshot = { nodes: [], edges: [] };

export const useNodeHistory = (scheduleSave: () => void) => {
  const [nodes, setNodes] = useState<CanvasNode[]>(EMPTY_SNAPSHOT.nodes);
  const [edges, setEdges] = useState<CanvasEdge[]>(EMPTY_SNAPSHOT.edges);
  const nodesRef = useRef<CanvasNode[]>(nodes);
  const edgesRef = useRef<CanvasEdge[]>(edges);
  const historyRef = useRef<CanvasSnapshot[]>([]);
  const historyIndexRef = useRef(-1);

  const pushSnapshot = useCallback((snap: CanvasSnapshot) => {
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    trimmed.push(snap);
    if (trimmed.length > MAX_HISTORY) trimmed.shift();
    historyIndexRef.current = trimmed.length - 1;
    historyRef.current = trimmed;
  }, []);

  /**
   * Apply a partial snapshot. Any key omitted keeps its current value.
   * `addToHistory = false` is for drag-style mutations where we only want
   * to commit a single history slot on mouse-up (see `commitHistory`).
   */
  const applyState = useCallback(
    (patch: Partial<CanvasSnapshot>, addToHistory = true) => {
      const nextNodes = patch.nodes ?? nodesRef.current;
      const nextEdges = patch.edges ?? edgesRef.current;
      if (addToHistory) {
        pushSnapshot({ nodes: nextNodes, edges: nextEdges });
      }
      if (patch.nodes) {
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
      }
      if (patch.edges) {
        edgesRef.current = nextEdges;
        setEdges(nextEdges);
      }
      scheduleSave();
    },
    [pushSnapshot, scheduleSave],
  );

  // Back-compat shim: existing call sites use `applyNodes(newNodes, addToHistory?)`.
  const applyNodes = useCallback(
    (newNodes: CanvasNode[], addToHistory = true) => {
      applyState({ nodes: newNodes }, addToHistory);
    },
    [applyState],
  );

  const applyEdges = useCallback(
    (newEdges: CanvasEdge[], addToHistory = true) => {
      applyState({ edges: newEdges }, addToHistory);
    },
    [applyState],
  );

  const commitHistory = useCallback(() => {
    const current: CanvasSnapshot = {
      nodes: nodesRef.current,
      edges: edgesRef.current,
    };
    const last = historyRef.current[historyIndexRef.current];
    if (
      last &&
      current.nodes === last.nodes &&
      current.edges === last.edges
    ) {
      return;
    }
    pushSnapshot(current);
  }, [pushSnapshot]);

  const applySnapshot = useCallback((snap: CanvasSnapshot) => {
    nodesRef.current = snap.nodes;
    edgesRef.current = snap.edges;
    setNodes(snap.nodes);
    setEdges(snap.edges);
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    applySnapshot(historyRef.current[historyIndexRef.current]);
    scheduleSave();
  }, [applySnapshot, scheduleSave]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    applySnapshot(historyRef.current[historyIndexRef.current]);
    scheduleSave();
  }, [applySnapshot, scheduleSave]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    nodesRef,
    edgesRef,
    historyRef,
    historyIndexRef,
    applyNodes,
    applyEdges,
    applyState,
    commitHistory,
    undo,
    redo,
  };
};

import { useCallback, useRef, useState } from 'react';
import type { CanvasNode } from '../types';

const MAX_HISTORY = 100;

export const useNodeHistory = (scheduleSave: () => void) => {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const nodesRef = useRef<CanvasNode[]>(nodes);
  const historyRef = useRef<CanvasNode[][]>([]);
  const historyIndexRef = useRef(-1);

  const applyNodes = useCallback(
    (newNodes: CanvasNode[], addToHistory = true) => {
      if (addToHistory) {
        const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
        trimmed.push(newNodes);
        if (trimmed.length > MAX_HISTORY) trimmed.shift();
        historyIndexRef.current = trimmed.length - 1;
        historyRef.current = trimmed;
      }
      setNodes(newNodes);
      nodesRef.current = newNodes;
      scheduleSave();
    },
    [scheduleSave]
  );

  const commitHistory = useCallback(() => {
    const current = nodesRef.current;
    const last = historyRef.current[historyIndexRef.current];
    if (current === last) return;
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    trimmed.push(current);
    if (trimmed.length > MAX_HISTORY) trimmed.shift();
    historyIndexRef.current = trimmed.length - 1;
    historyRef.current = trimmed;
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    const snapshot = historyRef.current[historyIndexRef.current];
    setNodes(snapshot);
    nodesRef.current = snapshot;
    scheduleSave();
  }, [scheduleSave]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    const snapshot = historyRef.current[historyIndexRef.current];
    setNodes(snapshot);
    nodesRef.current = snapshot;
    scheduleSave();
  }, [scheduleSave]);

  return { nodes, setNodes, nodesRef, historyRef, historyIndexRef, applyNodes, commitHistory, undo, redo };
};

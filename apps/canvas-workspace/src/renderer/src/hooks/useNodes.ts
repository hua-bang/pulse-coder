import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasNode, CanvasTransform, CanvasSaveData, FrameNodeData, FileNodeData } from '../types';
import { genId, createDefaultNode, createNodeData } from '../utils/nodeFactory';
import { useNodeHistory } from './useNodeHistory';

const SAVE_DEBOUNCE_MS = 800;
const DEFAULT_CANVAS_ID = 'default';

export const useNodes = (
  canvasId = DEFAULT_CANVAS_ID,
  onRestoreTransform?: (t: CanvasTransform) => void
) => {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transformRef = useRef<CanvasTransform>({ x: 0, y: 0, scale: 1 });

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = window.canvasWorkspace?.store;
      if (!api) return;
      const payload: CanvasSaveData = {
        nodes: nodesRef.current,
        transform: transformRef.current,
        savedAt: new Date().toISOString(),
      };
      void api.save(canvasId, payload);
    }, SAVE_DEBOUNCE_MS);
  }, [canvasId]);

  const [loaded, setLoaded] = useState(false);

  const {
    nodes, setNodes, nodesRef, historyRef, historyIndexRef,
    applyNodes, commitHistory, undo, redo,
  } = useNodeHistory(scheduleSave);

  const setTransformForSave = useCallback(
    (t: CanvasTransform) => {
      transformRef.current = t;
      scheduleSave();
    },
    [scheduleSave]
  );

  // Start watching the workspace notes directory for external file changes (e.g. from MCP writes).
  // Only updates nodes that are not currently being edited by the user (modified === false).
  useEffect(() => {
    const storeApi = window.canvasWorkspace?.store;
    const fileApi = window.canvasWorkspace?.file;
    if (!storeApi || !fileApi) return;

    void storeApi.watchWorkspace(canvasId);

    const cleanup = fileApi.onChanged((filePath, content) => {
      const node = nodesRef.current.find(
        (n) =>
          n.type === 'file' &&
          (n.data as FileNodeData).filePath === filePath &&
          !(n.data as FileNodeData).modified
      );
      if (!node) return;
      const updated = nodesRef.current.map((n) =>
        n.id === node.id
          ? { ...n, data: { ...(n.data as FileNodeData), content, modified: false } }
          : n
      );
      applyNodes(updated, false);
    });

    return cleanup;
  }, [canvasId, applyNodes, nodesRef]);

  useEffect(() => {
    const api = window.canvasWorkspace?.store;
    if (!api) {
      const empty: CanvasNode[] = [];
      historyRef.current = [empty];
      historyIndexRef.current = 0;
      setNodes(empty);
      setLoaded(true);
      return;
    }
    void api.load(canvasId).then((result) => {
      if (result.ok && result.data) {
        const saved = result.data;
        if (Array.isArray(saved.nodes)) {
          setNodes(saved.nodes);
          nodesRef.current = saved.nodes;
          historyRef.current = [saved.nodes];
          historyIndexRef.current = 0;
        } else {
          historyRef.current = [[]];
          historyIndexRef.current = 0;
        }
        if (saved.transform && onRestoreTransform) {
          onRestoreTransform(saved.transform);
        }
      } else {
        historyRef.current = [[]];
        historyIndexRef.current = 0;
      }
      setLoaded(true);
    });
  }, [canvasId, onRestoreTransform]);

  const addNode = useCallback(
    (type: CanvasNode['type'], x: number, y: number) => {
      const node = createDefaultNode(type, x, y);

      if (type === 'file') {
        const api = window.canvasWorkspace?.file;
        if (api) {
          void api.createNote(canvasId).then((res) => {
            if (res.ok && res.filePath) {
              setNodes((prev) => {
                const updated = prev.map((n) =>
                  n.id === node.id
                    ? { ...n, title: res.fileName?.replace(/\.md$/, '') || n.title, data: { ...n.data, filePath: res.filePath ?? '' } }
                    : n
                );
                nodesRef.current = updated;
                return updated;
              });
              scheduleSave();
            }
          });
        }
      }

      applyNodes([...nodesRef.current, node]);
      return node;
    },
    [applyNodes, scheduleSave, canvasId, setNodes, nodesRef]
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      applyNodes(nodesRef.current.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    },
    [applyNodes, nodesRef]
  );

  const removeNode = useCallback(
    (id: string) => {
      applyNodes(nodesRef.current.filter((n) => n.id !== id));
    },
    [applyNodes, nodesRef]
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      applyNodes(nodesRef.current.filter((n) => !ids.includes(n.id)));
    },
    [applyNodes, nodesRef]
  );

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      applyNodes(nodesRef.current.map((n) => (n.id === id ? { ...n, x, y } : n)), false);
    },
    [applyNodes, nodesRef]
  );

  const moveNodes = useCallback(
    (moves: Array<{ id: string; x: number; y: number }>) => {
      applyNodes(
        nodesRef.current.map((n) => {
          const m = moves.find((mv) => mv.id === n.id);
          return m ? { ...n, x: m.x, y: m.y } : n;
        }),
        false
      );
    },
    [applyNodes, nodesRef]
  );

  const resizeNode = useCallback(
    (id: string, width: number, height: number) => {
      applyNodes(nodesRef.current.map((n) => (n.id === id ? { ...n, width, height } : n)), false);
    },
    [applyNodes, nodesRef]
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const source = nodesRef.current.find((n) => n.id === id);
      if (!source) return null;
      const newNode: CanvasNode = {
        ...source,
        id: genId(),
        x: source.x + 24,
        y: source.y + 24,
        data: source.type === 'frame'
          ? { ...(source.data as FrameNodeData) }
          : createNodeData(source.type),
      };
      if (newNode.type === 'file') {
        const api = window.canvasWorkspace?.file;
        if (api) {
          void api.createNote(canvasId).then((res) => {
            if (res.ok && res.filePath) {
              setNodes((prev) => {
                const updated = prev.map((n) =>
                  n.id === newNode.id
                    ? { ...n, title: res.fileName?.replace(/\.md$/, '') || n.title, data: { ...n.data, filePath: res.filePath ?? '' } }
                    : n
                );
                nodesRef.current = updated;
                return updated;
              });
              scheduleSave();
            }
          });
        }
      }
      applyNodes([...nodesRef.current, newNode]);
      return newNode;
    },
    [applyNodes, scheduleSave, canvasId, setNodes, nodesRef]
  );

  const pasteNodes = useCallback(
    (sources: CanvasNode[], offsetX = 24, offsetY = 24) => {
      if (sources.length === 0) return [];
      const newNodes = sources.map((source) => ({
        ...source,
        id: genId(),
        x: source.x + offsetX,
        y: source.y + offsetY,
        data: source.type === 'frame'
          ? { ...(source.data as FrameNodeData) }
          : createNodeData(source.type),
      }));
      newNodes.forEach((newNode) => {
        if (newNode.type === 'file') {
          const api = window.canvasWorkspace?.file;
          if (api) {
            void api.createNote(canvasId).then((res) => {
              if (res.ok && res.filePath) {
                setNodes((prev) => {
                  const updated = prev.map((n) =>
                    n.id === newNode.id
                      ? { ...n, title: res.fileName?.replace(/\.md$/, '') || n.title, data: { ...n.data, filePath: res.filePath ?? '' } }
                      : n
                  );
                  nodesRef.current = updated;
                  return updated;
                });
                scheduleSave();
              }
            });
          }
        }
      });
      applyNodes([...nodesRef.current, ...newNodes]);
      return newNodes;
    },
    [applyNodes, scheduleSave, canvasId, setNodes, nodesRef]
  );

  return {
    nodes,
    loaded,
    addNode,
    updateNode,
    removeNode,
    removeNodes,
    moveNode,
    moveNodes,
    resizeNode,
    setTransformForSave,
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
  };
};

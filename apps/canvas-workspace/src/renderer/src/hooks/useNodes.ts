import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasNode, CanvasTransform, CanvasSaveData, FrameNodeData } from "../types";

let nodeIdCounter = 0;
const genId = () => `node-${Date.now()}-${++nodeIdCounter}`;

const SAVE_DEBOUNCE_MS = 800;
const MAX_HISTORY = 100;
const DEFAULT_CANVAS_ID = "default";

export const useNodes = (
  canvasId = DEFAULT_CANVAS_ID,
  onRestoreTransform?: (t: CanvasTransform) => void
) => {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const transformRef = useRef<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  const historyRef = useRef<CanvasNode[][]>([]);
  const historyIndexRef = useRef(-1);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = window.canvasWorkspace?.store;
      if (!api) return;
      const payload: CanvasSaveData = {
        nodes: nodesRef.current,
        transform: transformRef.current,
        savedAt: new Date().toISOString()
      };
      void api.save(canvasId, payload);
    }, SAVE_DEBOUNCE_MS);
  }, [canvasId]);

  const setTransformForSave = useCallback(
    (t: CanvasTransform) => {
      transformRef.current = t;
      scheduleSave();
    },
    [scheduleSave]
  );

  // Central mutation point — optionally pushes a history snapshot
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

  useEffect(() => {
    const api = window.canvasWorkspace?.store;
    if (!api) {
      const empty: CanvasNode[] = [];
      historyRef.current = [empty];
      historyIndexRef.current = 0;
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
    (type: "file" | "terminal" | "frame", x: number, y: number) => {
      const node: CanvasNode = {
        id: genId(),
        type,
        title: type === "file" ? "Untitled" : type === "terminal" ? "Terminal" : "Frame",
        x,
        y,
        width: type === "file" ? 420 : type === "terminal" ? 480 : 600,
        height: type === "file" ? 360 : type === "terminal" ? 300 : 400,
        data:
          type === "file"
            ? { filePath: "", content: "", saved: false, modified: false }
            : type === "terminal"
              ? { sessionId: "" }
              : { color: "#9065b0" }
      };

      // Auto-create note file for file nodes
      if (type === "file") {
        const api = window.canvasWorkspace?.file;
        if (api) {
          void api.createNote(canvasId).then((res) => {
            if (res.ok && res.filePath) {
              setNodes((prev) => {
                const updated = prev.map((n) =>
                  n.id === node.id
                    ? {
                        ...n,
                        title: res.fileName?.replace(/\.md$/, "") || n.title,
                        data: {
                          ...n.data,
                          filePath: res.filePath ?? ''
                        }
                      }
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
    [applyNodes, scheduleSave, canvasId]
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      applyNodes(nodesRef.current.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    },
    [applyNodes]
  );

  const removeNode = useCallback(
    (id: string) => {
      applyNodes(nodesRef.current.filter((n) => n.id !== id));
    },
    [applyNodes]
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      applyNodes(nodesRef.current.filter((n) => !ids.includes(n.id)));
    },
    [applyNodes]
  );

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      applyNodes(
        nodesRef.current.map((n) => (n.id === id ? { ...n, x, y } : n)),
        false
      );
    },
    [applyNodes]
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
    [applyNodes]
  );

  const resizeNode = useCallback(
    (id: string, width: number, height: number) => {
      applyNodes(
        nodesRef.current.map((n) => (n.id === id ? { ...n, width, height } : n)),
        false
      );
    },
    [applyNodes]
  );

  // Call after drag/resize ends to commit the final position to history
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

  const duplicateNode = useCallback(
    (id: string) => {
      const source = nodesRef.current.find((n) => n.id === id);
      if (!source) return null;
      const newNode: CanvasNode = {
        ...source,
        id: genId(),
        x: source.x + 24,
        y: source.y + 24,
        data:
          source.type === 'file'
            ? { filePath: '', content: '', saved: false, modified: false }
            : source.type === 'terminal'
              ? { sessionId: '' }
              : { ...(source.data as FrameNodeData) },
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
    [applyNodes, scheduleSave, canvasId]
  );

  const pasteNodes = useCallback(
    (sources: CanvasNode[], offsetX = 24, offsetY = 24) => {
      if (sources.length === 0) return [];
      const newNodes = sources.map((source) => ({
        ...source,
        id: genId(),
        x: source.x + offsetX,
        y: source.y + offsetY,
        data:
          source.type === 'file'
            ? { filePath: '', content: '', saved: false, modified: false }
            : source.type === 'terminal'
              ? { sessionId: '' }
              : { ...(source.data as FrameNodeData) },
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
    [applyNodes, scheduleSave, canvasId]
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

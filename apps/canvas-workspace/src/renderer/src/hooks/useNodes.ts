import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasNode, CanvasTransform, CanvasSaveData } from "../types";

let nodeIdCounter = 0;
const genId = () => `node-${Date.now()}-${++nodeIdCounter}`;

const SAVE_DEBOUNCE_MS = 800;
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

  useEffect(() => {
    const api = window.canvasWorkspace?.store;
    if (!api) {
      setLoaded(true);
      return;
    }
    void api.load(canvasId).then((result) => {
      if (result.ok && result.data) {
        const saved = result.data;
        if (Array.isArray(saved.nodes)) {
          setNodes(saved.nodes);
        }
        if (saved.transform && onRestoreTransform) {
          onRestoreTransform(saved.transform);
        }
      }
      setLoaded(true);
    });
  }, [canvasId, onRestoreTransform]);

  const addNode = useCallback(
    (type: "file" | "terminal", x: number, y: number) => {
      const node: CanvasNode = {
        id: genId(),
        type,
        title: type === "file" ? "Untitled" : "Terminal",
        x,
        y,
        width: type === "file" ? 420 : 480,
        height: type === "file" ? 360 : 300,
        data:
          type === "file"
            ? { filePath: "", content: "", saved: false, modified: false }
            : { sessionId: "" }
      };

      // Auto-create note file for file nodes
      if (type === "file") {
        const api = window.canvasWorkspace?.file;
        if (api) {
          void api.createNote(canvasId).then((res) => {
            if (res.ok && res.filePath) {
              setNodes((prev) =>
                prev.map((n) =>
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
                )
              );
              scheduleSave();
            }
          });
        }
      }

      setNodes((prev) => [...prev, node]);
      scheduleSave();
      return node;
    },
    [scheduleSave]
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, ...patch } : n))
      );
      scheduleSave();
    },
    [scheduleSave]
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== id));
      scheduleSave();
    },
    [scheduleSave]
  );

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      updateNode(id, { x, y });
    },
    [updateNode]
  );

  const resizeNode = useCallback(
    (id: string, width: number, height: number) => {
      updateNode(id, { width, height });
    },
    [updateNode]
  );

  return {
    nodes,
    loaded,
    addNode,
    updateNode,
    removeNode,
    moveNode,
    resizeNode,
    setTransformForSave
  };
};

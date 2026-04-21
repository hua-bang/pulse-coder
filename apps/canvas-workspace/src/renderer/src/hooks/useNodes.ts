import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CanvasEdge,
  CanvasNode,
  CanvasSaveData,
  CanvasTransform,
  FileNodeData,
  FrameNodeData,
  ImageNodeData,
  MindmapNodeData,
  ShapeNodeData,
  TextNodeData,
} from '../types';
import { cloneMindmapTopic, createDefaultNode, createNodeData, genId } from '../utils/nodeFactory';
import { degradeEndpointsForDeletedNode } from '../utils/edgeFactory';
import { useNodeHistory } from './useNodeHistory';

const SAVE_DEBOUNCE_MS = 800;
const DEFAULT_CANVAS_ID = 'default';

export const useNodes = (
  canvasId = DEFAULT_CANVAS_ID,
  onRestoreTransform?: (t: CanvasTransform) => void
) => {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transformRef = useRef<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  const onRestoreTransformRef = useRef(onRestoreTransform);
  onRestoreTransformRef.current = onRestoreTransform;

  /**
   * Mirrors `loaded` state so `doSave`/`flushSave` (stable callbacks) can
   * synchronously check it without re-creating on every render. We refuse
   * any save before the initial load completes — otherwise an early
   * `beforeunload` / unmount flushSave can persist an empty node list
   * over the real data on disk.
   */
  const loadedRef = useRef(false);

  /**
   * Ids that have been confirmed on disk in this session — either seeded
   * from the initial load or from a completed save. The `onExternalUpdate`
   * handler uses this to distinguish "CLI deleted a persisted node" (drop)
   * from "renderer just created a node whose save is still debounced"
   * (keep). Without this guard, a watcher fire that arrives while an
   * add-node save is still pending would treat the fresh in-memory node
   * as a CLI delete and wipe it from the canvas.
   */
  const persistedIdsRef = useRef<Set<string>>(new Set());

  const doSave = useCallback(() => {
    if (!loadedRef.current) {
      console.debug(`[canvas] save skipped for ${canvasId}: not yet loaded`);
      return;
    }
    const api = window.canvasWorkspace?.store;
    if (!api) {
      console.warn('[canvas] save skipped: store API unavailable');
      return;
    }
    const snapshot = nodesRef.current;
    const edgeSnapshot = edgesRef.current;
    const payload: CanvasSaveData = {
      nodes: snapshot,
      edges: edgeSnapshot,
      transform: transformRef.current,
      savedAt: new Date().toISOString(),
    };
    console.debug(
      `[canvas] saving ${canvasId}: ${payload.nodes.length} nodes, ${edgeSnapshot.length} edges`,
    );
    void api.save(canvasId, payload).then((res) => {
      if (!res.ok) {
        console.warn('[canvas] save failed:', res.error);
        return;
      }
      // Save succeeded — every id we just persisted is now on disk, so
      // it's safe for the external-update handler to treat future
      // disk-absence of these ids as "deleted elsewhere".
      for (const n of snapshot) persistedIdsRef.current.add(n.id);
    });
  }, [canvasId]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      doSave();
    }, SAVE_DEBOUNCE_MS);
  }, [doSave]);

  /** Flush any pending debounced save immediately. */
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    doSave();
  }, [doSave]);

  const [loaded, setLoaded] = useState(false);

  const {
    nodes, edges, setNodes, setEdges, nodesRef, edgesRef,
    historyRef, historyIndexRef,
    applyNodes, applyEdges, applyState, commitHistory, undo, redo,
  } = useNodeHistory(scheduleSave);

  const setTransformForSave = useCallback(
    (t: CanvasTransform) => {
      transformRef.current = t;
      scheduleSave();
    },
    [scheduleSave]
  );

  /**
   * IDs of nodes recently touched by an external process (canvas-cli). The
   * Canvas component reads this to render a transient "agent edited here"
   * highlight. Entries expire after ~2.5s.
   */
  const [externallyEditedIds, setExternallyEditedIds] = useState<Set<string>>(() => new Set());
  const externalClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Listen for canvas-cli writes bubbled up from the main process via the
  // local IPC socket. When we hear about a change, pull the fresh nodes
  // straight from disk (to handle arbitrary field updates including file
  // content, terminal scrollback, frame label, etc) and merge them into
  // our in-memory state WITHOUT calling scheduleSave — the disk is already
  // authoritative for these ids, and re-saving would race against the CLI.
  useEffect(() => {
    const storeApi = window.canvasWorkspace?.store;
    if (!storeApi?.onExternalUpdate) return;

    const unsubscribe = storeApi.onExternalUpdate(async (event) => {
      if (event.workspaceId !== canvasId) return;
      if (!Array.isArray(event.nodeIds) || event.nodeIds.length === 0) return;
      // Drop events that arrive before the initial load completes —
      // the upcoming load will read the latest disk state anyway, and
      // operating on an empty nodesRef here would corrupt the view.
      if (!loadedRef.current) return;

      const result = await storeApi.load(canvasId);
      if (!result.ok || !result.data || !Array.isArray(result.data.nodes)) return;
      const diskNodes = result.data.nodes;
      const diskById = new Map<string, CanvasNode>();
      for (const n of diskNodes) diskById.set(n.id, n);
      // Any id we can read from disk is by definition persisted.
      for (const n of diskNodes) persistedIdsRef.current.add(n.id);

      // Semantics of `event.nodeIds`: every id here is a node that main's
      // fs.watch diff saw differ between its last-known snapshot and the
      // fresh disk contents. For each id, the combination of disk presence
      // and whether we've ever persisted it ourselves tells us what to do:
      //   - on disk only                         → CLI create, append
      //   - on disk AND in memory                → CLI update, replace in place
      //   - memory only, id was persisted before → CLI delete, drop
      //   - memory only, id never persisted      → local create whose save
      //                                            is still debounced; keep it.
      //                                            Dropping here would wipe
      //                                            nodes the user just added
      //                                            via the toolbar/context menu.
      const changedIds = new Set(event.nodeIds);
      const nextNodes: CanvasNode[] = [];
      const seen = new Set<string>();
      for (const cur of nodesRef.current) {
        seen.add(cur.id);
        if (changedIds.has(cur.id)) {
          const disk = diskById.get(cur.id);
          if (disk) {
            // update
            nextNodes.push(disk);
          } else if (!persistedIdsRef.current.has(cur.id)) {
            // Locally added, not yet saved — keep it so the pending
            // debounced save can still flush it.
            nextNodes.push(cur);
          }
          // else: persisted before and now absent from disk → CLI delete, drop.
        } else {
          nextNodes.push(cur);
        }
      }
      // Append CLI-created nodes that weren't in memory yet.
      for (const id of changedIds) {
        if (seen.has(id)) continue;
        const disk = diskById.get(id);
        if (disk) nextNodes.push(disk);
      }

      // Apply directly without history / scheduleSave to avoid a write-back loop.
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      // Edges for Step 1: treat disk as authoritative. CLI-side edge mutations
      // are rare compared to node changes, and the external-update event
      // currently carries no edge-level granularity. Replacing wholesale
      // keeps us in sync for the common cases (CLI added/removed an edge,
      // or a bound node was deleted elsewhere and edges were degraded).
      const diskEdges = Array.isArray(result.data.edges) ? result.data.edges : [];
      edgesRef.current = diskEdges;
      setEdges(diskEdges);

      // Mark the affected nodes as externally-edited for 2.5s so the Canvas
      // component can render a transient highlight.
      setExternallyEditedIds((prev) => {
        const next = new Set(prev);
        for (const id of changedIds) next.add(id);
        return next;
      });
      for (const id of changedIds) {
        const existing = externalClearTimers.current.get(id);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          setExternallyEditedIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          externalClearTimers.current.delete(id);
        }, 2500);
        externalClearTimers.current.set(id, t);
      }
    });

    return () => {
      unsubscribe();
      for (const t of externalClearTimers.current.values()) clearTimeout(t);
      externalClearTimers.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  // File-watcher sync is temporarily disabled.  The fs.watch-based watcher
  // introduced race conditions with user edits (the onChanged callback could
  // call applyNodes with stale nodesRef.current, reverting in-flight changes).
  // To re-enable, flip FILE_WATCHER_ENABLED in file-watcher.ts and uncomment
  // the block below.
  //
  // useEffect(() => {
  //   const storeApi = window.canvasWorkspace?.store;
  //   const fileApi = window.canvasWorkspace?.file;
  //   if (!storeApi || !fileApi) return;
  //   void storeApi.watchWorkspace(canvasId);
  //   const cleanup = fileApi.onChanged((filePath, content) => {
  //     const node = nodesRef.current.find(
  //       (n) =>
  //         n.type === 'file' &&
  //         (n.data as FileNodeData).filePath === filePath &&
  //         !(n.data as FileNodeData).modified
  //     );
  //     if (!node) return;
  //     const updated = nodesRef.current.map((n) =>
  //       n.id === node.id
  //         ? { ...n, data: { ...(n.data as FileNodeData), content, modified: false } }
  //         : n
  //     );
  //     applyNodes(updated, false);
  //   });
  //   return cleanup;
  // }, [canvasId, applyNodes, nodesRef]);

  useEffect(() => {
    // New canvas selected — block saves until this load finishes.
    loadedRef.current = false;
    const api = window.canvasWorkspace?.store;
    if (!api) {
      const empty: CanvasNode[] = [];
      const emptyEdges: CanvasEdge[] = [];
      historyRef.current = [{ nodes: empty, edges: emptyEdges }];
      historyIndexRef.current = 0;
      setNodes(empty);
      setEdges(emptyEdges);
      loadedRef.current = true;
      setLoaded(true);
      return;
    }
    persistedIdsRef.current = new Set();
    void api.load(canvasId).then((result) => {
      if (result.ok && result.data) {
        const saved = result.data;
        const loadedNodes = Array.isArray(saved.nodes) ? saved.nodes : [];
        const loadedEdges = Array.isArray(saved.edges) ? saved.edges : [];
        setNodes(loadedNodes);
        setEdges(loadedEdges);
        nodesRef.current = loadedNodes;
        edgesRef.current = loadedEdges;
        historyRef.current = [{ nodes: loadedNodes, edges: loadedEdges }];
        historyIndexRef.current = 0;
        // Every node we loaded is on disk — seed the persisted set so
        // the external-update handler can tell future deletes apart
        // from locally-added unsaved nodes.
        for (const n of loadedNodes) persistedIdsRef.current.add(n.id);
        if (saved.transform && onRestoreTransformRef.current) {
          onRestoreTransformRef.current(saved.transform);
        }
      } else {
        historyRef.current = [{ nodes: [], edges: [] }];
        historyIndexRef.current = 0;
      }
      loadedRef.current = true;
      setLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  const addNode = useCallback(
    (type: CanvasNode['type'], x: number, y: number) => {
      const node = { ...createDefaultNode(type, x, y), updatedAt: Date.now() };

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
      applyNodes(
        nodesRef.current.map((n) =>
          n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n,
        ),
      );
    },
    [applyNodes, nodesRef]
  );

  const removeNode = useCallback(
    (id: string) => {
      const victim = nodesRef.current.find((n) => n.id === id);
      const nextNodes = nodesRef.current.filter((n) => n.id !== id);
      // Any edges bound to the deleted node get their endpoints degraded
      // to free points at the node's last-known anchor — preserving the
      // user's drawn connections instead of silently deleting them. This
      // is one atomic history step so undo reverses both the node delete
      // and the endpoint degradation together.
      const nextEdges = victim
        ? degradeEndpointsForDeletedNode(edgesRef.current, victim)
        : edgesRef.current;
      applyState({ nodes: nextNodes, edges: nextEdges });
    },
    [applyState, edgesRef, nodesRef]
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const victims = nodesRef.current.filter((n) => idSet.has(n.id));
      const nextNodes = nodesRef.current.filter((n) => !idSet.has(n.id));
      let nextEdges = edgesRef.current;
      for (const victim of victims) {
        nextEdges = degradeEndpointsForDeletedNode(nextEdges, victim);
      }
      applyState({ nodes: nextNodes, edges: nextEdges });
    },
    [applyState, edgesRef, nodesRef]
  );

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      applyNodes(
        nodesRef.current.map((n) =>
          n.id === id ? { ...n, x, y, updatedAt: Date.now() } : n,
        ),
        false,
      );
    },
    [applyNodes, nodesRef]
  );

  const moveNodes = useCallback(
    (moves: Array<{ id: string; x: number; y: number }>) => {
      const now = Date.now();
      applyNodes(
        nodesRef.current.map((n) => {
          const m = moves.find((mv) => mv.id === n.id);
          return m ? { ...n, x: m.x, y: m.y, updatedAt: now } : n;
        }),
        false
      );
    },
    [applyNodes, nodesRef]
  );

  const resizeNode = useCallback(
    (id: string, width: number, height: number) => {
      applyNodes(
        nodesRef.current.map((n) =>
          n.id === id ? { ...n, width, height, updatedAt: Date.now() } : n,
        ),
        false,
      );
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
          : source.type === 'text'
            ? { ...(source.data as TextNodeData) }
            : source.type === 'image'
              ? { ...(source.data as ImageNodeData) }
              : source.type === 'shape'
                ? { ...(source.data as ShapeNodeData) }
                : source.type === 'mindmap'
                  ? (() => {
                      const src = source.data as MindmapNodeData;
                      return {
                        ...src,
                        root: cloneMindmapTopic(src.root),
                        rev: 0,
                      } satisfies MindmapNodeData;
                    })()
                  : createNodeData(source.type),
        updatedAt: Date.now(),
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
      const now = Date.now();
      const newNodes = sources.map((source) => ({
        ...source,
        id: genId(),
        x: source.x + offsetX,
        y: source.y + offsetY,
        data: source.type === 'frame'
          ? { ...(source.data as FrameNodeData) }
          : source.type === 'text'
            ? { ...(source.data as TextNodeData) }
            : source.type === 'image'
              ? { ...(source.data as ImageNodeData) }
              : source.type === 'shape'
                ? { ...(source.data as ShapeNodeData) }
                : source.type === 'mindmap'
                  ? (() => {
                      const src = source.data as MindmapNodeData;
                      return {
                        ...src,
                        root: cloneMindmapTopic(src.root),
                        rev: 0,
                      } satisfies MindmapNodeData;
                    })()
                  : createNodeData(source.type),
        updatedAt: now,
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

  const addEdge = useCallback(
    (edge: CanvasEdge) => {
      applyEdges([...edgesRef.current, edge]);
      return edge;
    },
    [applyEdges, edgesRef],
  );

  const updateEdge = useCallback(
    (id: string, patch: Partial<CanvasEdge>, addToHistory = true) => {
      applyEdges(
        edgesRef.current.map((e) =>
          e.id === id ? { ...e, ...patch, updatedAt: Date.now() } : e,
        ),
        addToHistory,
      );
    },
    [applyEdges, edgesRef],
  );

  const removeEdge = useCallback(
    (id: string) => {
      applyEdges(edgesRef.current.filter((e) => e.id !== id));
    },
    [applyEdges, edgesRef],
  );

  const removeEdges = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      applyEdges(edgesRef.current.filter((e) => !idSet.has(e.id)));
    },
    [applyEdges, edgesRef],
  );

  return {
    nodes,
    edges,
    loaded,
    externallyEditedIds,
    addNode,
    updateNode,
    removeNode,
    removeNodes,
    moveNode,
    moveNodes,
    resizeNode,
    addEdge,
    updateEdge,
    removeEdge,
    removeEdges,
    setTransformForSave,
    flushSave,
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
  };
};

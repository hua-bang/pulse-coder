import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { useCanvas } from '../../hooks/useCanvas';
import { useNodes } from '../../hooks/useNodes';
import { useNodeDrag } from '../../hooks/useNodeDrag';
import { useNodeResize } from '../../hooks/useNodeResize';
import { useCanvasContext } from '../../hooks/useCanvasContext';
import { useCanvasFit } from '../../hooks/useCanvasFit';
import { useCanvasKeyboard } from '../../hooks/useCanvasKeyboard';
import { useCanvasImagePaste } from '../../hooks/useCanvasImagePaste';
import { useEdgeInteraction } from '../../hooks/useEdgeInteraction';
import { useShapeDraw } from '../../hooks/useShapeDraw';
import { useMarqueeSelect } from '../../hooks/useMarqueeSelect';
import { useAppShell } from '../AppShellProvider';
import { NODE_TYPE_LABELS } from '../../constants/interaction';
import type { CanvasNode } from '../../types';
import type { PaletteCommand } from '../CommandPalette';
import { computeFrameDepths } from '../../utils/frameHierarchy';
import { getNodeDisplayLabel } from '../../utils/nodeLabel';
import { exportMindmapNodeToPng } from '../../utils/mindmapExport';
import type { CanvasNodeRenameRequest } from '../../types/ui-interaction';
import { CanvasSurface } from './CanvasSurface';
import { CanvasOverlays } from './CanvasOverlays';

interface CanvasProps {
  canvasId: string;
  canvasName?: string;
  rootFolder?: string;
  hidden?: boolean;
  onNodesChange?: (canvasId: string, nodes: CanvasNode[]) => void;
  onSelectionChange?: (canvasId: string, selectedNodeIds: string[]) => void;
  focusNodeId?: string;
  onFocusComplete?: () => void;
  deleteNodeId?: string;
  onDeleteComplete?: () => void;
  renameRequest?: CanvasNodeRenameRequest;
  onRenameComplete?: () => void;
  chatPanelOpen?: boolean;
  onChatToggle?: () => void;
}

export const Canvas = ({
  canvasId,
  canvasName,
  rootFolder,
  hidden,
  onNodesChange,
  onSelectionChange,
  focusNodeId,
  onFocusComplete,
  deleteNodeId,
  onDeleteComplete,
  renameRequest,
  onRenameComplete,
  chatPanelOpen,
  onChatToggle,
}: CanvasProps) => {
  const { confirm, notify, openShortcuts, isOverlayOpen } = useAppShell();
  const [activeTool, setActiveTool] = useState('select');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [clipboardNodes, setClipboardNodes] = useState<CanvasNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoFitted = useRef(false);
  const [contextMenu, setContextMenu] = useState<{
    screenX: number;
    screenY: number;
    canvasX: number;
    canvasY: number;
  } | null>(null);

  // Set to true at the end of a real marquee drag so the click event
  // that fires immediately afterward doesn't fall through to the blank-
  // canvas-click handler and wipe the selection we just made.
  const suppressBlankClickRef = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    transform,
    setTransform,
    moving,
    handleWheel,
    handleMouseDown: canvasMouseDown,
    handleMouseMove: canvasMouseMove,
    handleMouseUp: canvasMouseUp,
    screenToCanvas,
    resetTransform,
  } = useCanvas(activeTool === 'hand');

  const { animating, handleFocusNode, fitAllNodes } = useCanvasFit(containerRef, setTransform);

  const {
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
    setTransformForSave,
    flushSave,
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
    groupNodes,
  } = useNodes(canvasId, () => {});

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Which edge (if any) is in label-edit mode. Driven by dbl-click on
  // the edge body; cleared on blur/Escape/Enter. Stored here (not inside
  // EdgeLabel) so that selecting a different edge or deleting the edge
  // can forcibly end the edit session.
  const [editingEdgeLabelId, setEditingEdgeLabelId] = useState<string | null>(null);

  // Flush pending saves on window close or component unmount
  useEffect(() => {
    const handler = () => { flushSave(); };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      flushSave();
    };
  }, [flushSave]);

  // Only persist transform after data has loaded to avoid saving empty nodes
  useEffect(() => {
    if (!loaded) return;
    setTransformForSave(transform);
  }, [loaded, transform, setTransformForSave]);

  // Auto-fit all nodes into view on initial load
  useEffect(() => {
    if (loaded && !hasAutoFitted.current) {
      hasAutoFitted.current = true;
      if (nodes.length > 0) fitAllNodes(nodes);
    }
  }, [loaded, nodes, fitAllNodes]);

  // Report nodes to parent only after loaded
  useEffect(() => {
    if (!loaded) return;
    onNodesChange?.(canvasId, nodes);
  }, [canvasId, nodes, loaded, onNodesChange]);

  // Report selection so adjacent UI, such as the Agent panel, can scope work
  // to the same nodes the user has visually selected.
  useEffect(() => {
    if (!loaded) return;
    onSelectionChange?.(canvasId, selectedNodeIds);
  }, [canvasId, loaded, onSelectionChange, selectedNodeIds]);

  // Handle external focus request (e.g. from sidebar layers panel)
  useEffect(() => {
    if (!loaded) return;
    if (!focusNodeId) return;
    const node = nodes.find((n) => n.id === focusNodeId);
    if (node) {
      setSelectedNodeIds([node.id]);
      setHighlightedId(node.id);
      handleFocusNode(node);
    }
    onFocusComplete?.();
  }, [focusNodeId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle external delete request (e.g. from sidebar layers context menu)
  useEffect(() => {
    if (!loaded) return;
    if (!deleteNodeId) return;
    if (nodes.some((n) => n.id === deleteNodeId)) {
      removeNode(deleteNodeId);
      setSelectedNodeIds((ids) => ids.filter((id) => id !== deleteNodeId));
    }
    onDeleteComplete?.();
  }, [deleteNodeId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded) return;
    if (!renameRequest) return;
    if (renameRequest.workspaceId !== canvasId) return;

    const node = nodes.find((item) => item.id === renameRequest.nodeId);
    if (node && node.title !== renameRequest.title) {
      updateNode(node.id, { title: renameRequest.title });
    }
    onRenameComplete?.();
  }, [renameRequest, loaded, canvasId, nodes, updateNode, onRenameComplete]);

  const requestRemoveNodes = useCallback(async (ids: string[]) => {
    const victims = nodes.filter((node) => ids.includes(node.id));
    if (victims.length === 0) return;

    const accepted = await confirm({
      intent: 'danger',
      title: victims.length === 1
        ? `Delete "${getNodeDisplayLabel(victims[0])}"?`
        : `Delete ${victims.length} selected nodes?`,
      description: victims.length === 1
        ? 'Connected arrows stay on the canvas and detach from the deleted node.'
        : 'Connected arrows stay on the canvas and detach from the deleted nodes.',
      confirmLabel: victims.length === 1 ? 'Delete node' : 'Delete nodes',
    });
    if (!accepted) return;

    removeNodes(victims.map((node) => node.id));
    const removedIds = new Set(victims.map((node) => node.id));
    setSelectedNodeIds((current) => current.filter((id) => !removedIds.has(id)));
    notify({
      tone: 'success',
      title: victims.length === 1 ? 'Node deleted' : 'Nodes deleted',
      description: victims.length === 1
        ? getNodeDisplayLabel(victims[0])
        : `${victims.length} items were removed from the canvas.`,
    });
  }, [nodes, confirm, removeNodes, notify]);

  const requestRemoveEdge = useCallback(async (id: string) => {
    const edge = edges.find((item) => item.id === id);
    if (!edge) return;

    const accepted = await confirm({
      intent: 'danger',
      title: 'Delete this connection?',
      description: 'This removes the arrow and its label from the canvas.',
      confirmLabel: 'Delete connection',
    });
    if (!accepted) return;

    removeEdge(id);
    setSelectedEdgeId((current) => (current === id ? null : current));
    if (editingEdgeLabelId === id) setEditingEdgeLabelId(null);
    notify({
      tone: 'success',
      title: 'Connection deleted',
      description: edge.label?.trim() ? edge.label : 'Arrow removed from the canvas.',
    });
  }, [edges, confirm, removeEdge, editingEdgeLabelId, notify]);

  useCanvasContext(rootFolder, nodes, canvasName);

  const groupSelectedNodes = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    const frame = groupNodes(selectedNodeIds);
    if (!frame) return;
    setSelectedNodeIds([frame.id]);
    notify({
      tone: 'success',
      title: 'Nodes grouped',
      description: `Wrapped ${selectedNodeIds.length} node${selectedNodeIds.length === 1 ? '' : 's'} in a new frame.`,
    });
  }, [groupNodes, selectedNodeIds, notify]);

  useCanvasKeyboard({
    undo, redo, nodes, selectedNodeIds, setSelectedNodeIds,
    selectedEdgeId, setSelectedEdgeId, removeEdge: requestRemoveEdge,
    duplicateNode, clipboardNodes, setClipboardNodes, pasteNodes, groupSelectedNodes,
    removeNodes: requestRemoveNodes,
    moveNodes, commitHistory,
    searchOpen, setSearchOpen, contextMenu, setContextMenu,
    setHighlightedId, handleFocusNode,
    keyboardLocked: isOverlayOpen,
  });

  useCanvasImagePaste({
    canvasId,
    active: !hidden,
    containerRef,
    screenToCanvas,
    addNode,
    updateNode,
    onCreated: (node) => setSelectedNodeIds([node.id]),
  });

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedId) {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 1500);
    }
  }, [highlightedId]);

  const handleSearchSelect = useCallback((node: CanvasNode) => {
    setSelectedNodeIds([node.id]);
    setHighlightedId(node.id);
    handleFocusNode(node);
  }, [handleFocusNode]);

  const { draggingId, draggingIds, snapLines, onDragStart, onDragMove, onDragEnd } = useNodeDrag(
    moveNode, moveNodes, transform.scale, nodes, selectedNodeIds
  );
  const { resizingId, onResizeStart, onResizeMove, onResizeEnd } =
    useNodeResize(resizeNode, transform.scale);

  // sortedNodes is the render order (frames first, non-frames on top,
  // deeper frames over shallower). It doubles as the hit-test stack
  // for edge interactions — we iterate it in reverse so the topmost
  // node under the cursor wins.
  const sortedNodes = useMemo(
    () => {
      const depths = computeFrameDepths(nodes);
      return [...nodes].sort((a, b) => {
        if (a.type === 'frame' && b.type !== 'frame') return -1;
        if (a.type !== 'frame' && b.type === 'frame') return 1;
        if (a.type === 'frame' && b.type === 'frame') {
          return (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
        }
        return 0;
      });
    },
    [nodes]
  );

  const getContainer = useCallback(() => containerRef.current, []);

  const {
    state: edgeInteractionState,
    beginConnect,
    beginMoveEnd,
    beginMoveBend,
    beginMoveEdge,
    getPreviewEndpoints,
  } = useEdgeInteraction({
    nodes,
    sortedNodes,
    screenToCanvas,
    getContainer,
    addEdge,
    updateEdge,
    commitHistory,
    edges,
    // After the user commits one arrow, hop back to the select tool and
    // auto-select the new edge so the style panel is immediately
    // available. Matches tldraw's "draw one arrow, then edit" flow and
    // fixes the "cursor is still in connect mode, hard to adjust the
    // nodes around it" feedback.
    onConnectCommitted: (edgeId) => {
      setActiveTool('select');
      setSelectedEdgeId(edgeId);
      setSelectedNodeIds([]);
    },
  });

  const handleEdgeHandleMouseDown = useCallback(
    (
      edgeId: string,
      handle: 'source' | 'target' | 'bend',
      e: React.MouseEvent,
      ctx: { s: { x: number; y: number }; t: { x: number; y: number } },
    ) => {
      if (handle === 'bend') {
        beginMoveBend(edgeId, ctx.s, ctx.t, e.clientX, e.clientY);
      } else {
        beginMoveEnd(edgeId, handle, e.clientX, e.clientY);
      }
    },
    [beginMoveBend, beginMoveEnd],
  );

  const handleConnectOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      beginConnect(e.clientX, e.clientY);
    },
    [beginConnect],
  );

  const {
    draft: shapeDraft,
    handleOverlayMouseDown: handleShapeOverlayMouseDown,
    isActive: shapeToolActive,
  } = useShapeDraw({
    activeTool,
    screenToCanvas,
    getContainer,
    addNode,
    updateNode,
    // Drop back to the select tool and select the committed shape so the
    // user can immediately restyle it via the ShapeStylePicker.
    onCommitted: (node) => {
      setActiveTool('select');
      setSelectedNodeIds([node.id]);
      setSelectedEdgeId(null);
    },
  });

  const handleEdgeBodyMouseDown = useCallback(
    (edgeId: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      beginMoveEdge(edgeId, e.clientX, e.clientY);
    },
    [beginMoveEdge],
  );

  const handleMarqueeSelect = useCallback(
    (ids: string[], mods: { shift: boolean; meta: boolean }) => {
      // Suppress the click event that fires right after a real drag
      // (otherwise the blank-canvas click handler would clear what we
      // just selected). A zero-distance "drag" still falls through to
      // the click handler — that's how a plain click on blank canvas
      // continues to clear the selection.
      if (ids.length > 0) suppressBlankClickRef.current = true;

      if (mods.shift || mods.meta) {
        // The modifier explicitly says "extend", so even an empty-hit
        // click on blank canvas must NOT collapse the existing
        // selection. Suppress the trailing click handler regardless of
        // the hit count.
        suppressBlankClickRef.current = true;
        // Toggle each hit id in/out of the selection so a marquee with
        // shift extends the current group and a second pass over the
        // same nodes deselects them.
        setSelectedNodeIds((current) => {
          const next = new Set(current);
          for (const id of ids) {
            if (next.has(id)) next.delete(id);
            else next.add(id);
          }
          return Array.from(next);
        });
        if (ids.length > 0) setSelectedEdgeId(null);
        return;
      }

      // Plain marquee replaces the selection. An empty hit set on a
      // tiny drag falls through to the click handler that clears
      // selection — we don't double-clear here.
      if (ids.length > 0) {
        setSelectedNodeIds(ids);
        setSelectedEdgeId(null);
      }
    },
    []
  );

  const marquee = useMarqueeSelect({
    // Only the plain select tool should own blank-canvas drags. Connect
    // and shape modes mount their own full-canvas overlays that already
    // intercept mousedown, so the redundant `activeTool === 'connect'`
    // check is intentionally omitted — TS narrows it away.
    enabled: activeTool === 'select' && !shapeToolActive,
    screenToCanvas,
    getContainer,
    nodes,
    onSelect: handleMarqueeSelect,
  });

  const handleEdgeBodyDoubleClick = useCallback(
    (edgeId: string) => {
      // Ensure the edge is selected before editing so the style panel
      // stays in sync with the edge the user is labeling.
      setSelectedEdgeId(edgeId);
      setSelectedNodeIds([]);
      setEditingEdgeLabelId(edgeId);
    },
    [],
  );

  const handleCommitEditEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      // Normalize: empty or whitespace-only labels clear the field back
      // to `undefined`, keeping the stored data clean (and making the
      // label chip disappear from the overlay).
      const trimmed = label.trim();
      updateEdge(edgeId, { label: trimmed.length > 0 ? trimmed : undefined });
      setEditingEdgeLabelId(null);
    },
    [updateEdge],
  );

  const handleCancelEditEdgeLabel = useCallback(() => {
    setEditingEdgeLabelId(null);
  }, []);

  const isBlankCanvasTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest(
      '.canvas-node, .floating-toolbar, .zoom-indicator, .context-menu, .canvas-edges, .canvas-connect-overlay, .canvas-shape-overlay, .edge-style-panel',
    );
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, canvasX: pos.x, canvasY: pos.y });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, canvasX: pos.x, canvasY: pos.y });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleCreateNode = useCallback(
    (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeIds([node.id]);
      setContextMenu(null);
      notify({
        tone: 'success',
        title: `${NODE_TYPE_LABELS[type]} added`,
        description: 'Placed on the canvas.',
      });
    },
    [addNode, contextMenu, notify]
  );

  const handleExportMindmapImage = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      const api = window.canvasWorkspace?.file;
      if (!node || node.type !== 'mindmap' || !api) return;

      notify({
        tone: 'loading',
        title: 'Exporting mindmap...',
        description: getNodeDisplayLabel(node),
      });

      try {
        const image = await exportMindmapNodeToPng(node);
        const result = await api.exportImage(image.fileName, image.data, 'png');
        if (!result.ok) {
          if (result.canceled) {
            notify({
              tone: 'info',
              title: 'Export canceled',
              description: getNodeDisplayLabel(node),
            });
            return;
          }
          throw new Error(result.error ?? 'The image could not be saved.');
        }
        notify({
          tone: 'success',
          title: 'Mindmap image exported',
          description: result.filePath ?? image.fileName,
        });
      } catch (err) {
        notify({
          tone: 'error',
          title: 'Mindmap export failed',
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [nodes, notify],
  );

  const handleToolbarAddNode = useCallback(
    (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2, containerRef.current);
      const halfW =
        type === 'file' ? 210
        : type === 'terminal' ? 240
        : type === 'agent' ? 260
        : type === 'text' ? 130
        : type === 'iframe' ? 260
        : type === 'mindmap' ? 320
        : 300;
      const halfH =
        type === 'frame' ? 200
        : type === 'text' ? 60
        : type === 'iframe' ? 200
        : type === 'mindmap' ? 210
        : 150;
      const node = addNode(type, pos.x - halfW, pos.y - halfH);
      setSelectedNodeIds([node.id]);
      notify({
        tone: 'success',
        title: `${NODE_TYPE_LABELS[type]} added`,
        description: 'Centered in the current viewport.',
      });
    },
    [addNode, screenToCanvas, notify]
  );

  // Command catalog for Cmd+K. Built lazily so each command captures
  // the latest selection / tool / chat state — the palette is only
  // mounted while open, so the cost of rebuilding on every render is
  // negligible compared to the clarity of inlining the bindings here.
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const selectionCount = selectedNodeIds.length;
    const list: PaletteCommand[] = [
      // Selection-dependent commands (rendered first when active so
      // batch operations are one keypress away from a multi-selection).
      {
        id: 'duplicate-selection',
        group: 'edit',
        title: selectionCount > 1
          ? `Duplicate ${selectionCount} selected nodes`
          : 'Duplicate selected node',
        shortcut: 'Cmd+D',
        enabled: selectionCount > 0,
        run: () => {
          const created: string[] = [];
          for (const id of selectedNodeIds) {
            const copy = duplicateNode(id);
            if (copy) created.push(copy.id);
          }
          if (created.length > 0) setSelectedNodeIds(created);
        },
      },
      {
        id: 'delete-selection',
        group: 'edit',
        title: selectionCount > 1
          ? `Delete ${selectionCount} selected nodes`
          : 'Delete selected node',
        shortcut: 'Del',
        enabled: selectionCount > 0,
        run: () => {
          void requestRemoveNodes(selectedNodeIds);
        },
      },
      {
        id: 'group-selection',
        group: 'edit',
        title: selectionCount > 1
          ? `Group ${selectionCount} selected nodes in a frame`
          : 'Wrap selected node in a frame',
        shortcut: 'Cmd+G',
        aliases: ['frame', 'wrap'],
        enabled: selectionCount > 0,
        run: () => {
          groupSelectedNodes();
        },
      },
      // Create — one entry per node type. Aliases catch the common
      // alternative names users type ("markdown" → file, "ai" → agent).
      {
        id: 'create-note',
        group: 'create',
        title: 'New note',
        hint: 'Markdown file backed by disk',
        aliases: ['file', 'markdown', 'doc', 'md'],
        run: () => handleToolbarAddNode('file'),
      },
      {
        id: 'create-terminal',
        group: 'create',
        title: 'Open terminal',
        aliases: ['shell', 'pty', 'console', 'bash'],
        run: () => handleToolbarAddNode('terminal'),
      },
      {
        id: 'create-agent',
        group: 'create',
        title: 'Create agent',
        hint: 'Run an AI coding agent in a PTY',
        aliases: ['ai', 'chat', 'assistant', 'claude'],
        run: () => handleToolbarAddNode('agent'),
      },
      {
        id: 'create-text',
        group: 'create',
        title: 'Add text',
        aliases: ['label', 'sticky', 'note'],
        run: () => handleToolbarAddNode('text'),
      },
      {
        id: 'create-frame',
        group: 'create',
        title: 'Add frame',
        hint: 'Visual grouping rectangle',
        aliases: ['group', 'box', 'container'],
        run: () => handleToolbarAddNode('frame'),
      },
      {
        id: 'create-link',
        group: 'create',
        title: 'Embed link',
        aliases: ['iframe', 'web', 'url', 'browser'],
        run: () => handleToolbarAddNode('iframe'),
      },
      {
        id: 'create-mindmap',
        group: 'create',
        title: 'New mindmap',
        aliases: ['tree', 'topic', 'outline'],
        run: () => handleToolbarAddNode('mindmap'),
      },
      // Navigate / View
      {
        id: 'fit-all',
        group: 'navigate',
        title: 'Fit all nodes in view',
        hint: 'Zoom and center to show every node',
        aliases: ['zoom', 'overview', 'show all'],
        enabled: nodes.length > 0,
        run: () => fitAllNodes(nodes),
      },
      {
        id: 'reset-zoom',
        group: 'navigate',
        title: 'Reset zoom to 100%',
        aliases: ['1:1', 'actual size'],
        run: () => resetTransform(),
      },
      {
        id: 'toggle-chat',
        group: 'view',
        title: chatPanelOpen ? 'Hide chat panel' : 'Show chat panel',
        shortcut: 'Cmd+Shift+A',
        aliases: ['ai', 'sidebar', 'assistant'],
        enabled: !!onChatToggle,
        run: () => onChatToggle?.(),
      },
      // Help
      {
        id: 'shortcuts',
        group: 'help',
        title: 'Show keyboard shortcuts',
        shortcut: '?',
        aliases: ['keys', 'bindings', 'cheatsheet'],
        run: () => openShortcuts(),
      },
    ];
    return list;
  }, [
    selectedNodeIds,
    duplicateNode,
    requestRemoveNodes,
    groupSelectedNodes,
    handleToolbarAddNode,
    fitAllNodes,
    nodes,
    resetTransform,
    chatPanelOpen,
    onChatToggle,
    openShortcuts,
  ]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      // A click that follows a real marquee drag would otherwise fall
      // through and clear the selection we just made. Consume the flag
      // (set in handleMarqueeSelect) and bail.
      if (suppressBlankClickRef.current) {
        suppressBlankClickRef.current = false;
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-node')) return;
      // Clicking inside the edges SVG (either a hit-proxy or a handle)
      // lands on a child of .canvas-edges. Those children stopPropagate
      // their own onMouseDown, but the click event can still arrive
      // here — ignore it so we don't wipe the selection we just set.
      if (target.closest('.canvas-edges')) return;
      // EdgeStylePanel clicks already stopPropagation in its own handlers,
      // but this belt-and-braces check covers any edge cases where an
      // internal button relies on default bubbling.
      if (target.closest('.edge-style-panel')) return;
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    },
    [contextMenu]
  );

  const handleRootMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Pan gestures (middle-click, alt-drag, hand tool) take priority
      // over marquee — useCanvas owns those flows and they should keep
      // working from anywhere on the canvas, blank or not.
      const isPanGesture =
        e.button === 1 ||
        (e.button === 0 && e.altKey) ||
        (e.button === 0 && activeTool === 'hand');
      if (isPanGesture) {
        canvasMouseDown(e);
        return;
      }
      // Left-click on truly blank canvas with the select tool → start
      // a marquee. The hook's hit-test runs on mouseup; tiny drags
      // (treated as clicks) report empty hits and fall through to the
      // canvas-click handler that clears selection.
      if (
        e.button === 0 &&
        activeTool === 'select' &&
        isBlankCanvasTarget(e.target)
      ) {
        marquee.begin(e);
        return;
      }
      canvasMouseDown(e);
    },
    [activeTool, canvasMouseDown, isBlankCanvasTarget, marquee]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      canvasMouseMove(e);
      onDragMove(e);
      onResizeMove(e);
    },
    [canvasMouseMove, onDragMove, onResizeMove]
  );

  const handleMouseUp = useCallback(() => {
    canvasMouseUp();
    onDragEnd();
    onResizeEnd();
    commitHistory();
  }, [canvasMouseUp, onDragEnd, onResizeEnd, commitHistory]);

  const cursorClass = activeTool === 'hand'
    ? ' canvas-container--hand'
    : shapeToolActive ? ' canvas-container--shape'
    : resizingId ? ' canvas-container--resizing' : '';

  if (!loaded) {
    return (
      <div className="canvas-container">
        <div className="canvas-empty-hint">
          <div className="hint-text">Loading workspace...</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`canvas-container${cursorClass}`}
      style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      onWheel={handleWheel}
      onMouseDown={handleRootMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
    >
      <div className="canvas-grid" />

      <CanvasSurface
        transform={transform}
        animating={animating}
        moving={moving}
        sortedNodes={sortedNodes}
        nodes={nodes}
        edges={edges}
        rootFolder={rootFolder}
        canvasId={canvasId}
        canvasName={canvasName}
        draggingId={draggingId}
        draggingIds={draggingIds}
        resizingId={resizingId}
        selectedNodeIds={selectedNodeIds}
        selectedEdgeId={selectedEdgeId}
        highlightedId={highlightedId}
        externallyEditedIds={externallyEditedIds}
        edgeInteractionState={edgeInteractionState}
        edgePreviewEndpoints={getPreviewEndpoints()}
        shapeDraft={shapeDraft}
        marqueeRect={marquee.rect}
        snapLines={snapLines}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onUpdate={updateNode}
        onAutoResize={resizeNode}
        onRemove={(id) => {
          void requestRemoveNodes([id]);
        }}
        onSelect={(id, mods) => {
          // Shift-click extends the selection (additive); Cmd/Ctrl-click
          // toggles the clicked id in/out of the selection. Plain click
          // collapses the selection to just this node — but only if it
          // wasn't already selected, so a click on a member of an
          // existing multi-selection preserves the group (matches Figma /
          // Finder semantics and keeps multi-drag from collapsing on the
          // mousedown that initiates it).
          if (mods?.shift || mods?.meta) {
            setSelectedNodeIds((current) =>
              current.includes(id) ? current.filter((cid) => cid !== id) : [...current, id]
            );
          } else {
            setSelectedNodeIds((current) =>
              current.length > 1 && current.includes(id) ? current : [id]
            );
          }
          setSelectedEdgeId(null);
        }}
        onExportMindmapImage={handleExportMindmapImage}
        onFocus={handleFocusNode}
        onSelectEdge={(id) => {
          setSelectedEdgeId(id);
          if (id) setSelectedNodeIds([]);
        }}
        onEdgeHandleMouseDown={handleEdgeHandleMouseDown}
        onEdgeBodyMouseDown={handleEdgeBodyMouseDown}
        onEdgeBodyDoubleClick={handleEdgeBodyDoubleClick}
      />

      <CanvasOverlays
        nodes={nodes}
        contextMenu={contextMenu}
        searchOpen={searchOpen}
        activeTool={activeTool}
        scale={transform.scale}
        selectionCount={selectedNodeIds.length}
        chatPanelOpen={chatPanelOpen}
        onChatToggle={onChatToggle}
        onCreateNode={handleCreateNode}
        onCloseContextMenu={() => setContextMenu(null)}
        onOpenShortcuts={openShortcuts}
        onToolChange={setActiveTool}
        onAddNode={handleToolbarAddNode}
        onResetTransform={resetTransform}
        paletteCommands={paletteCommands}
        onSearchSelect={handleSearchSelect}
        onCloseSearch={() => setSearchOpen(false)}
        onConnectMouseDown={handleConnectOverlayMouseDown}
        shapeToolActive={shapeToolActive}
        onShapeMouseDown={handleShapeOverlayMouseDown}
        selectedEdge={edges.find((e) => e.id === selectedEdgeId) ?? null}
        transform={transform}
        onUpdateEdge={(id, patch) => {
          // Style mutations are single-step edits; commit to history
          // by default so undo reverses one color/width change at a time.
          updateEdge(id, patch);
        }}
        onRemoveEdge={(id) => {
          void requestRemoveEdge(id);
        }}
        edges={edges}
        editingEdgeLabelId={editingEdgeLabelId}
        onStartEditEdgeLabel={handleEdgeBodyDoubleClick}
        onCommitEditEdgeLabel={handleCommitEditEdgeLabel}
        onCancelEditEdgeLabel={handleCancelEditEdgeLabel}
      />
    </div>
  );
};

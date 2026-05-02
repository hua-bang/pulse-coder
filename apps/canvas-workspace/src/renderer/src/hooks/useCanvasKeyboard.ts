import { useEffect } from 'react';
import type { CanvasNode } from '../types';

interface Options {
  undo: () => void;
  redo: () => void;
  nodes: CanvasNode[];
  selectedNodeIds: string[];
  setSelectedNodeIds: (ids: string[]) => void;
  /** Currently selected edge (if any). Delete/Backspace removes it; Esc
   *  deselects it before falling through to node-deselect. */
  selectedEdgeId: string | null;
  setSelectedEdgeId: (id: string | null) => void;
  removeEdge: (id: string) => void | Promise<void>;
  duplicateNode: (id: string) => CanvasNode | null;
  clipboardNodes: CanvasNode[];
  setClipboardNodes: (nodes: CanvasNode[]) => void;
  pasteNodes: (nodes: CanvasNode[]) => CanvasNode[];
  /** Wrap the current node selection in a new frame. */
  groupSelectedNodes: () => void;
  removeNodes: (ids: string[]) => void | Promise<void>;
  searchOpen: boolean;
  setSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  contextMenu: unknown;
  setContextMenu: (menu: null) => void;
  setHighlightedId: (id: string | null) => void;
  handleFocusNode: (node: CanvasNode) => void;
  keyboardLocked?: boolean;
}

export const useCanvasKeyboard = ({
  undo, redo, nodes, selectedNodeIds, setSelectedNodeIds,
  selectedEdgeId, setSelectedEdgeId, removeEdge,
  duplicateNode, clipboardNodes, setClipboardNodes, pasteNodes, groupSelectedNodes, removeNodes,
  searchOpen, setSearchOpen, contextMenu, setContextMenu,
  setHighlightedId, handleFocusNode,
  keyboardLocked = false,
}: Options) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (keyboardLocked) return;

      const active = document.activeElement;
      const isEditable = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable
      );
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && (e.key === 'k' || e.key === 'h') && !isEditable) {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }
      if (isMod && !e.shiftKey && e.key === 'z' && !isEditable) {
        e.preventDefault();
        undo();
        return;
      }
      if (isMod && e.shiftKey && e.key === 'z' && !isEditable) {
        e.preventDefault();
        redo();
        return;
      }
      if (isMod && e.key === 'a' && !isEditable) {
        e.preventDefault();
        setSelectedNodeIds(nodes.map((n) => n.id));
        return;
      }
      if (isMod && e.key === 'd' && !isEditable) {
        e.preventDefault();
        if (selectedNodeIds.length === 1) {
          const newNode = duplicateNode(selectedNodeIds[0]);
          if (newNode) setSelectedNodeIds([newNode.id]);
        }
        return;
      }
      if (isMod && e.key === 'c' && !isEditable) {
        const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
        if (selected.length > 0) setClipboardNodes(selected);
        return;
      }
      if (isMod && (e.key === 'g' || e.key === 'G') && !e.shiftKey && !isEditable) {
        e.preventDefault();
        if (selectedNodeIds.length > 0) groupSelectedNodes();
        return;
      }
      if (isMod && e.key === 'v' && !isEditable) {
        if (clipboardNodes.length > 0) {
          e.preventDefault();
          const created = pasteNodes(clipboardNodes);
          setSelectedNodeIds(created.map((n) => n.id));
        }
        return;
      }
      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); return; }
        if (contextMenu) { setContextMenu(null); return; }
        if (selectedEdgeId) { setSelectedEdgeId(null); return; }
        setSelectedNodeIds([]);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable) {
        if (selectedEdgeId) {
          e.preventDefault();
          void removeEdge(selectedEdgeId);
          return;
        }
        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          void removeNodes(selectedNodeIds);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, nodes, selectedNodeIds, setSelectedNodeIds, selectedEdgeId, setSelectedEdgeId, removeEdge, duplicateNode, clipboardNodes, setClipboardNodes, pasteNodes, groupSelectedNodes, removeNodes, searchOpen, setSearchOpen, contextMenu, setContextMenu, keyboardLocked]);

  // Cmd/Ctrl+Tab to cycle through nodes (Shift reverses direction)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (keyboardLocked) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'Tab') {
        const activeEl = document.activeElement;
        const isEditable = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          (activeEl as HTMLElement).isContentEditable
        );
        if (!isEditable && nodes.length > 0) {
          e.preventDefault();
          const currentIndex = nodes.findIndex((n) => n.id === selectedNodeIds[0]);
          let nextIndex: number;
          if (e.shiftKey) {
            nextIndex = currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
          } else {
            nextIndex = currentIndex >= nodes.length - 1 ? 0 : currentIndex + 1;
          }
          const nextNode = nodes[nextIndex];
          setSelectedNodeIds([nextNode.id]);
          setHighlightedId(nextNode.id);
          handleFocusNode(nextNode);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, selectedNodeIds, setSelectedNodeIds, setHighlightedId, handleFocusNode, keyboardLocked]);
};

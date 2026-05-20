import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '../Canvas';
import { FileNodeEditorRegistryProvider } from '../../hooks/useFileNodeEditorRegistry';
import { ChatPanel } from '../chat';
import { ReferenceDrawer, type ReferenceEntry } from '../ReferenceDrawer';
import type { WorkspaceEntry } from '../../hooks/useWorkspaces';
import type { WorkbenchController } from './useWorkbenchState';

export { useWorkbenchState } from './useWorkbenchState';
export type { WorkbenchController } from './useWorkbenchState';

const DEFAULT_CHAT_WIDTH = 420;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

const EMPTY_REFERENCES: ReferenceEntry[] = [];

interface WorkbenchProps {
  activeWorkspaceId: string;
  workspaces: WorkspaceEntry[];
  controller: WorkbenchController;
}

export const Workbench: React.FC<WorkbenchProps> = ({
  activeWorkspaceId,
  workspaces,
  controller,
}) => {
  const {
    allNodes,
    activeNodes,
    activeSelectedNode,
    selectedNodeIdsByWorkspace,
    focusRequest,
    deleteRequest,
    renameRequest,
    handleNodesChange,
    handleSelectionChange,
    requestNodeFocus,
    clearFocusRequest,
    clearDeleteRequest,
    clearRenameRequest,
  } = controller;

  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [referenceDrawerOpen, setReferenceDrawerOpen] = useState(false);
  const [referencesByWorkspace, setReferencesByWorkspace] = useState<Record<string, ReferenceEntry[]>>({});
  const [activeReferenceIdByWorkspace, setActiveReferenceIdByWorkspace] = useState<Record<string, string | undefined>>({});
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);

  // Lazy keep-alive: a workspace is mounted the first time it becomes
  // active and stays mounted (hidden via display:none) thereafter, so
  // re-selecting it is instant. Workspaces the user never visits never
  // mount their Canvas / iframe webviews — this is what keeps startup
  // from spinning up an Electron webContents for every link node across
  // every saved workspace.
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<Set<string>>(
    () => (activeWorkspaceId ? new Set([activeWorkspaceId]) : new Set()),
  );

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setMountedWorkspaceIds((prev) => {
      if (prev.has(activeWorkspaceId)) return prev;
      const next = new Set(prev);
      next.add(activeWorkspaceId);
      return next;
    });
  }, [activeWorkspaceId]);

  const references = referencesByWorkspace[activeWorkspaceId] ?? EMPTY_REFERENCES;
  const activeReferenceId = activeReferenceIdByWorkspace[activeWorkspaceId];
  const activeReference = activeReferenceId
    ? references.find((entry) => ('kind' in entry && entry.kind === 'url' ? entry.id : entry.nodeId) === activeReferenceId)
    : undefined;
  const activeReferenceNode = activeReference && (!('kind' in activeReference) || activeReference.kind !== 'url')
    ? activeNodes.find((node) => node.id === activeReference.nodeId)
    : undefined;

  const removeReference = useCallback((referenceId: string) => {
    setReferencesByWorkspace((prev) => {
      const current = prev[activeWorkspaceId] ?? [];
      const next = current.filter((entry) => ('kind' in entry && entry.kind === 'url' ? entry.id : entry.nodeId) !== referenceId);
      if (next.length === current.length) return prev;
      return { ...prev, [activeWorkspaceId]: next };
    });
    setActiveReferenceIdByWorkspace((prev) => {
      if (prev[activeWorkspaceId] !== referenceId) return prev;
      return { ...prev, [activeWorkspaceId]: undefined };
    });
  }, [activeWorkspaceId]);

  const clearAllReferences = useCallback(() => {
    setReferencesByWorkspace((prev) => {
      if (!prev[activeWorkspaceId]?.length) return prev;
      return { ...prev, [activeWorkspaceId]: [] };
    });
    setActiveReferenceIdByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: undefined,
    }));
  }, [activeWorkspaceId]);

  const setReferenceGroup = useCallback((referenceId: string, group: string | undefined) => {
    const normalized = group?.trim() ? group.trim() : undefined;
    setReferencesByWorkspace((prev) => {
      const current = prev[activeWorkspaceId] ?? [];
      let changed = false;
      const next = current.map((entry) => {
        const id = 'kind' in entry && entry.kind === 'url' ? entry.id : entry.nodeId;
        if (id !== referenceId) return entry;
        if ((entry.group ?? undefined) === normalized) return entry;
        changed = true;
        return { ...entry, group: normalized };
      });
      if (!changed) return prev;
      return { ...prev, [activeWorkspaceId]: next };
    });
  }, [activeWorkspaceId]);

  const setActiveReference = useCallback((nodeId: string | undefined) => {
    setActiveReferenceIdByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: nodeId,
    }));
  }, [activeWorkspaceId]);

  const handleFocusReferenceNode = useCallback((nodeId: string) => {
    requestNodeFocus(activeWorkspaceId, nodeId);
  }, [activeWorkspaceId, requestNodeFocus]);

  useEffect(() => {
    const current = referencesByWorkspace[activeWorkspaceId];
    if (!current?.length) return;
    const known = new Set(activeNodes.map((node) => node.id));
    const filtered = current.filter((entry) => ('kind' in entry && entry.kind === 'url') || known.has(entry.nodeId));
    if (filtered.length === current.length) return;
    setReferencesByWorkspace((prev) => ({ ...prev, [activeWorkspaceId]: filtered }));
    setActiveReferenceIdByWorkspace((prev) => {
      const currentActive = prev[activeWorkspaceId];
      if (currentActive && filtered.some((entry) => ('kind' in entry && entry.kind === 'url' ? entry.id : entry.nodeId) === currentActive)) return prev;
      const nextActive = filtered[0] ? ('kind' in filtered[0] && filtered[0].kind === 'url' ? filtered[0].id : filtered[0].nodeId) : undefined;
      return { ...prev, [activeWorkspaceId]: nextActive };
    });
  }, [activeWorkspaceId, activeNodes, referencesByWorkspace]);

  const pinReferenceNode = useCallback((nodeId: string, group?: string) => {
    setReferencesByWorkspace((prev) => {
      const current = prev[activeWorkspaceId] ?? [];
      const exists = current.some((entry) => (!('kind' in entry) || entry.kind !== 'url') && entry.nodeId === nodeId);
      if (exists) return prev;
      const entry: ReferenceEntry = group ? { nodeId, group } : { nodeId };
      return { ...prev, [activeWorkspaceId]: [...current, entry] };
    });
    setActiveReferenceIdByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: nodeId,
    }));
    setReferenceDrawerOpen(true);
  }, [activeWorkspaceId]);

  const pinReferenceUrl = useCallback((url: string, title?: string) => {
    const id = `url:${url}`;
    setReferencesByWorkspace((prev) => {
      const current = prev[activeWorkspaceId] ?? [];
      const exists = current.some((entry) => 'kind' in entry && entry.kind === 'url' && entry.url === url);
      if (exists) return prev;
      const entry: ReferenceEntry = { kind: 'url', id, url, title };
      return { ...prev, [activeWorkspaceId]: [...current, entry] };
    });
    setActiveReferenceIdByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: id,
    }));
    setReferenceDrawerOpen(true);
  }, [activeWorkspaceId]);

  const resizing = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth + delta));
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [chatWidth]);

  return (
    <>
      <FileNodeEditorRegistryProvider>
      <ReferenceDrawer
        open={referenceDrawerOpen}
        references={references}
        activeReference={activeReference}
        activeReferenceNode={activeReferenceNode}
        nodes={activeNodes}
        selectedNode={activeSelectedNode}
        onOpenChange={setReferenceDrawerOpen}
        onSelectReference={setActiveReference}
        onRemoveReference={removeReference}
        onClearAll={clearAllReferences}
        onAddReference={pinReferenceNode}
        onAddUrlReference={pinReferenceUrl}
        onFocusNode={handleFocusReferenceNode}
      />
      <div className="canvas-viewport">
        {workspaces.filter((ws) => mountedWorkspaceIds.has(ws.id)).map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          return (
            <div
              key={ws.id}
              className="canvas-host"
              style={isActive ? undefined : { display: 'none' }}
            >
              <Canvas
                canvasId={ws.id}
                canvasName={ws.name}
                rootFolder={ws.rootFolder}
                isActive={isActive}
                onNodesChange={handleNodesChange}
                onSelectionChange={handleSelectionChange}
                focusNodeId={ws.id === focusRequest?.workspaceId ? focusRequest.nodeId : undefined}
                onFocusComplete={clearFocusRequest}
                deleteNodeId={ws.id === deleteRequest?.workspaceId ? deleteRequest.nodeId : undefined}
                onDeleteComplete={clearDeleteRequest}
                renameRequest={ws.id === renameRequest?.workspaceId ? renameRequest : undefined}
                onRenameComplete={clearRenameRequest}
                chatPanelOpen={chatPanelOpen}
                onChatToggle={() => setChatPanelOpen((prev) => !prev)}
                referenceDrawerOpen={referenceDrawerOpen}
                onReferenceToggle={() => setReferenceDrawerOpen((prev) => !prev)}
                onPinReferenceNode={pinReferenceNode}
              />
            </div>
          );
        })}
      </div>
      {workspaces.filter((ws) => mountedWorkspaceIds.has(ws.id)).map((ws) => (
        <div
          key={ws.id}
          className={`chat-panel-wrapper${chatPanelOpen && ws.id === activeWorkspaceId ? ' chat-panel-wrapper--open' : ''}`}
          style={ws.id !== activeWorkspaceId ? { display: 'none' } : chatPanelOpen ? { width: chatWidth } : undefined}
        >
          <ChatPanel
            workspaceId={ws.id}
            allWorkspaces={workspaces}
            nodes={allNodes[ws.id] || []}
            selectedNodeIds={selectedNodeIdsByWorkspace[ws.id] || []}
            rootFolder={ws.rootFolder}
            onClose={() => setChatPanelOpen(false)}
            onResizeStart={handleResizeStart}
            onNodeFocus={(nodeId) => requestNodeFocus(ws.id, nodeId)}
          />
        </div>
      ))}
      </FileNodeEditorRegistryProvider>
    </>
  );
};

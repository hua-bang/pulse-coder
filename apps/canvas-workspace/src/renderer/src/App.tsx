import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import './App.css';
import { Canvas } from './components/Canvas';
import { AppShellProvider, useAppShell } from './components/AppShellProvider';
import { ChatPage, ChatPanel } from './components/chat';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';
import { parseCanvasLocation } from './utils/canvasLinks';
import type { CanvasNode } from './types';
import type { CanvasNodeRenameRequest } from './types/ui-interaction';

const DEFAULT_CHAT_WIDTH = 420;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

const ROUTE_CANVAS = '/';
const ROUTE_CHAT = '/chat';

type ActiveView = 'canvas' | 'chat';

const AppContent = () => {
  const [location, setLocation] = useLocation();
  const { path: routePath, params: routeParams } = useMemo(
    () => parseCanvasLocation(location),
    [location],
  );
  const activeView: ActiveView = routePath === ROUTE_CHAT ? 'chat' : 'canvas';
  const routeQuery = routeParams.toString();

  const { notify, updateToast, confirm, openShortcuts, isOverlayOpen } = useAppShell();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [allNodes, setAllNodes] = useState<Record<string, CanvasNode[]>>({});
  const [selectedNodeIdsByWorkspace, setSelectedNodeIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>();
  const [deleteNodeId, setDeleteNodeId] = useState<string | undefined>();
  const [renameNodeRequest, setRenameNodeRequest] = useState<CanvasNodeRenameRequest | undefined>();
  const resizing = useRef(false);

  const handleNodesChange = useCallback((canvasId: string, nodes: CanvasNode[]) => {
    setAllNodes((prev) => {
      if (prev[canvasId] === nodes) return prev;
      return { ...prev, [canvasId]: nodes };
    });
  }, []);

  const handleSelectionChange = useCallback((canvasId: string, selectedNodeIds: string[]) => {
    setSelectedNodeIdsByWorkspace((prev) => {
      const existing = prev[canvasId] ?? [];
      if (
        existing.length === selectedNodeIds.length
        && existing.every((id, index) => id === selectedNodeIds[index])
      ) {
        return prev;
      }
      return { ...prev, [canvasId]: selectedNodeIds };
    });
  }, []);

  const handleFocusComplete = useCallback(() => {
    setFocusNodeId(undefined);
  }, []);

  const handleDeleteComplete = useCallback(() => {
    setDeleteNodeId(undefined);
  }, []);

  const handleRenameComplete = useCallback(() => {
    setRenameNodeRequest(undefined);
  }, []);

  const {
    workspaces,
    folders,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setRootFolder,
    importWorkspace,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolder,
    moveWorkspace,
    reorderFolder,
  } = useWorkspaces();

  useEffect(() => {
    if (!routeQuery) return;

    const targetWorkspaceId = routeParams.get('workspaceId') ?? activeId;
    const targetNodeId = routeParams.get('nodeId');
    if (!targetWorkspaceId) return;
    if (!workspaces.some((workspace) => workspace.id === targetWorkspaceId)) return;

    if (activeId !== targetWorkspaceId) {
      selectWorkspace(targetWorkspaceId);
    }
    if (targetNodeId) {
      setFocusNodeId(targetNodeId);
    }
    setLocation(ROUTE_CANVAS);
  }, [routeQuery, routeParams, activeId, workspaces, selectWorkspace, setLocation]);

  const enterChatView = useCallback(() => {
    setChatPanelOpen(false);
    setLocation(ROUTE_CHAT);
  }, [setLocation]);

  const exitChatView = useCallback(() => {
    setLocation(ROUTE_CANVAS);
  }, [setLocation]);

  const handleSelectWorkspace = useCallback((id: string) => {
    selectWorkspace(id);
    setLocation(ROUTE_CANVAS);
  }, [selectWorkspace, setLocation]);

  const handleCreateWorkspace = useCallback((name: string) => {
    const trimmed = name.trim() || 'Untitled';
    const id = createWorkspace(name);
    notify({
      tone: 'success',
      title: 'Workspace created',
      description: trimmed,
    });
    return id;
  }, [createWorkspace, notify]);

  const handleRenameWorkspace = useCallback((id: string, name: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    const trimmed = name.trim();
    if (!workspace || !trimmed || workspace.name === trimmed) return;
    renameWorkspace(id, trimmed);
    notify({
      tone: 'success',
      title: 'Workspace renamed',
      description: `${workspace.name} -> ${trimmed}`,
    });
  }, [workspaces, renameWorkspace, notify]);

  const handleDeleteWorkspace = useCallback(async (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;

    const accepted = await confirm({
      intent: 'danger',
      title: `Delete "${workspace.name}"?`,
      description: 'This removes the workspace canvas and its saved workspace directory from disk. This action cannot be undone.',
      confirmLabel: 'Delete workspace',
    });
    if (!accepted) return;

    const toastId = notify({
      tone: 'loading',
      title: `Deleting ${workspace.name}...`,
      description: 'Removing workspace data and saved canvas state.',
    });

    const result = await deleteWorkspace(id);
    if (!result.ok) {
      updateToast(toastId, {
        tone: 'error',
        title: 'Workspace deletion failed',
        description: result.error ?? 'The workspace could not be deleted.',
        autoCloseMs: 4200,
      });
      return;
    }

    updateToast(toastId, {
      tone: 'success',
      title: 'Workspace deleted',
      description: workspace.name,
      autoCloseMs: 2400,
    });
  }, [workspaces, confirm, notify, updateToast, deleteWorkspace]);


  const handleExportWorkspace = useCallback(async (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    const api = window.canvasWorkspace?.store;
    if (!workspace || !api) return;

    const toastId = notify({
      tone: 'loading',
      title: `Exporting ${workspace.name}...`,
      description: 'Packaging canvas state and workspace files.',
    });

    const result = await api.exportWorkspace(workspace.id, workspace.name);
    if (!result.ok) {
      if (result.canceled) {
        updateToast(toastId, {
          tone: 'info',
          title: 'Export canceled',
          description: workspace.name,
          autoCloseMs: 1800,
        });
        return;
      }
      updateToast(toastId, {
        tone: 'error',
        title: 'Workspace export failed',
        description: result.error ?? 'The workspace could not be exported.',
        autoCloseMs: 4200,
      });
      return;
    }

    updateToast(toastId, {
      tone: 'success',
      title: 'Workspace exported',
      description: result.filePath ?? `${workspace.name} (${result.fileCount ?? 0} files)`,
      autoCloseMs: 3600,
    });
  }, [workspaces, notify, updateToast]);

  const handleImportWorkspace = useCallback(async () => {
    const toastId = notify({
      tone: 'loading',
      title: 'Importing workspace...',
      description: 'Reading Pulse Canvas export file.',
    });

    const result = await importWorkspace();
    if (!result.ok) {
      if (result.canceled) {
        updateToast(toastId, {
          tone: 'info',
          title: 'Import canceled',
          description: 'No workspace was imported.',
          autoCloseMs: 1800,
        });
        return;
      }
      updateToast(toastId, {
        tone: 'error',
        title: 'Workspace import failed',
        description: result.error ?? 'The workspace export could not be imported.',
        autoCloseMs: 4200,
      });
      return;
    }

    updateToast(toastId, {
      tone: 'success',
      title: 'Workspace imported',
      description: `${result.workspace?.name ?? 'Imported Workspace'} (${result.fileCount ?? 0} files)`,
      autoCloseMs: 3000,
    });
    setLocation(ROUTE_CANVAS);
  }, [importWorkspace, notify, updateToast, setLocation]);

  const handleCreateFolder = useCallback((name: string) => {
    const trimmed = name.trim() || 'Untitled Folder';
    const id = createFolder(name);
    notify({
      tone: 'success',
      title: 'Folder created',
      description: trimmed,
    });
    return id;
  }, [createFolder, notify]);

  const handleRenameFolder = useCallback((id: string, name: string) => {
    const folder = folders.find((item) => item.id === id);
    const trimmed = name.trim();
    if (!folder || !trimmed || folder.name === trimmed) return;
    renameFolder(id, trimmed);
    notify({
      tone: 'success',
      title: 'Folder renamed',
      description: `${folder.name} -> ${trimmed}`,
    });
  }, [folders, renameFolder, notify]);

  const handleDeleteFolder = useCallback(async (id: string) => {
    const folder = folders.find((item) => item.id === id);
    if (!folder) return;

    const accepted = await confirm({
      intent: 'danger',
      title: `Delete folder "${folder.name}"?`,
      description: 'The folder will be removed and its workspaces will move back to the root list.',
      confirmLabel: 'Delete folder',
    });
    if (!accepted) return;

    deleteFolder(id);
    notify({
      tone: 'success',
      title: 'Folder deleted',
      description: `${folder.name} was removed. Nested workspaces were kept.`,
    });
  }, [folders, confirm, deleteFolder, notify]);

  const handleNodeRename = useCallback((nodeId: string, title: string) => {
    setRenameNodeRequest({ workspaceId: activeId, nodeId, title });
  }, [activeId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable = Boolean(target) && (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      );

      if (isOverlayOpen) return;

      if (!isEditable && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        openShortcuts();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        if (activeView !== 'canvas') return;
        e.preventDefault();
        setChatPanelOpen((prev) => !prev);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (activeView === 'chat') {
          setLocation(ROUTE_CANVAS);
        } else {
          setChatPanelOpen(false);
          setLocation(ROUTE_CHAT);
        }
        return;
      }

      if (e.key === 'Escape' && activeView === 'chat' && !isEditable) {
        setLocation(ROUTE_CANVAS);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeView, isOverlayOpen, openShortcuts, setLocation]);

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

  const handleNodeFocusFromChatPage = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    setLocation(ROUTE_CANVAS);
  }, [setLocation]);

  const activeWorkspace = workspaces.find((ws) => ws.id === activeId);

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
          workspaces={workspaces}
          folders={folders}
          activeId={activeId}
          onSelect={handleSelectWorkspace}
          onCreate={handleCreateWorkspace}
          onRename={handleRenameWorkspace}
          onDelete={handleDeleteWorkspace}
          onExport={handleExportWorkspace}
          onImport={handleImportWorkspace}
          onSetRootFolder={setRootFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onToggleFolder={toggleFolder}
          onMoveWorkspace={moveWorkspace}
          onReorderFolder={reorderFolder}
          activeNodes={allNodes[activeId] || []}
          onNodeFocus={setFocusNodeId}
          onNodeDelete={setDeleteNodeId}
          onNodeRename={handleNodeRename}
          activeView={activeView}
          onEnterChat={enterChatView}
          onExitChat={exitChatView}
        />
        {activeView === 'canvas' && (
          <>
            <div className="canvas-viewport">
              {workspaces.map((ws) => (
                <Canvas
                  key={ws.id}
                  canvasId={ws.id}
                  canvasName={ws.name}
                  rootFolder={ws.rootFolder}
                  hidden={ws.id !== activeId}
                  onNodesChange={handleNodesChange}
                  onSelectionChange={handleSelectionChange}
                  focusNodeId={ws.id === activeId ? focusNodeId : undefined}
                  onFocusComplete={handleFocusComplete}
                  deleteNodeId={ws.id === activeId ? deleteNodeId : undefined}
                  onDeleteComplete={handleDeleteComplete}
                  renameRequest={ws.id === renameNodeRequest?.workspaceId ? renameNodeRequest : undefined}
                  onRenameComplete={handleRenameComplete}
                  chatPanelOpen={chatPanelOpen}
                  onChatToggle={() => setChatPanelOpen((prev) => !prev)}
                />
              ))}
            </div>
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className={`chat-panel-wrapper${chatPanelOpen && ws.id === activeId ? ' chat-panel-wrapper--open' : ''}`}
                style={ws.id !== activeId ? { display: 'none' } : chatPanelOpen ? { width: chatWidth } : undefined}
              >
                <ChatPanel
                  workspaceId={ws.id}
                  allWorkspaces={workspaces}
                  nodes={allNodes[ws.id] || []}
                  selectedNodeIds={selectedNodeIdsByWorkspace[ws.id] || []}
                  rootFolder={ws.rootFolder}
                  onClose={() => setChatPanelOpen(false)}
                  onResizeStart={handleResizeStart}
                  onNodeFocus={setFocusNodeId}
                  onExpand={enterChatView}
                />
              </div>
            ))}
          </>
        )}
        {activeView === 'chat' && (
          <ChatPage
            initialWorkspaceId={activeId}
            allWorkspaces={workspaces}
            nodes={allNodes[activeId] || []}
            rootFolder={activeWorkspace?.rootFolder}
            onExit={exitChatView}
            onNodeFocus={handleNodeFocusFromChatPage}
          />
        )}
      </div>
    </div>
  );
};

const App = () => (
  <AppShellProvider>
    <AppContent />
  </AppShellProvider>
);

export default App;

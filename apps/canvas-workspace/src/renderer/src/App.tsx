import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import './App.css';
import { AppShellProvider, useAppShell } from './components/AppShellProvider';
import { ArtifactDrawer, ArtifactDrawerProvider } from './components/artifacts';
import './components/artifacts/artifacts.css';
import { ChatPage } from './components/chat';
import { LinkDrawer } from './components/LinkDrawer';
import { Sidebar } from './components/Sidebar';
import { getRegisteredNavItems, getRegisteredRoutes } from '../../plugins/renderer';
import { Workbench, useWorkbenchState } from './components/Workbench';
import { useWorkspaces } from './hooks/useWorkspaces';
import { parseCanvasLocation } from './utils/canvasLinks';
import { PulseRouter, PulseRouterView } from './components/router';

const ROUTE_CANVAS = '/';
const ROUTE_CHAT = '/chat';

// Plugin routes contribute their own URL paths; activeView widens to
// 'canvas' | 'chat' | <plugin route path>.
type ActiveView = 'canvas' | 'chat' | string;

const AppContent = () => {
  const [location, setLocation] = useLocation();
  const { path: routePath, params: routeParams } = useMemo(
    () => parseCanvasLocation(location),
    [location],
  );
  // Routes and nav items contributed by built-in plugins. Snapshot at
  // mount: built-in plugins register synchronously at renderer bootstrap,
  // so a one-shot read is sufficient.
  const pluginRoutes = useMemo(() => getRegisteredRoutes(), []);
  const pluginNavItems = useMemo(() => getRegisteredNavItems(), []);
  const activeView: ActiveView =
    routePath === ROUTE_CHAT
      ? 'chat'
      : pluginRoutes.some((r) => r.path === routePath)
        ? routePath
        : 'canvas';
  const routeQuery = routeParams.toString();

  const { notify, updateToast, confirm, openShortcuts, isOverlayOpen } = useAppShell();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const {
    workspaces,
    folders,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    importWorkspace,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolder,
    moveWorkspace,
    reorderWorkspace,
    reorderFolder,
  } = useWorkspaces();

  const workbench = useWorkbenchState({ activeWorkspaceId: activeId });
  const {
    activeNodes,
    ensureWorkspaceNodesLoaded,
    getWorkspaceNodes,
    requestNodeFocus,
    requestActiveNodeFocus,
    requestActiveNodeDelete,
    requestActiveNodeRename,
  } = workbench;

  useEffect(() => {
    if (!routeQuery || routePath !== ROUTE_CANVAS) return;

    const targetWorkspaceId = routeParams.get('workspaceId') ?? activeId;
    const targetNodeId = routeParams.get('nodeId');
    if (!targetWorkspaceId) return;
    if (!workspaces.some((workspace) => workspace.id === targetWorkspaceId)) return;

    if (activeId !== targetWorkspaceId) {
      selectWorkspace(targetWorkspaceId);
    }
    if (targetNodeId) {
      requestNodeFocus(targetWorkspaceId, targetNodeId);
    }
    setLocation(ROUTE_CANVAS);
  }, [routePath, routeQuery, routeParams, activeId, workspaces, selectWorkspace, requestNodeFocus, setLocation]);

  const enterChatView = useCallback(() => {
    setLocation(ROUTE_CHAT);
  }, [setLocation]);

  const exitChatView = useCallback(() => {
    setLocation(ROUTE_CANVAS);
  }, [setLocation]);

  // Plugin nav items declare their own paths; just hand off the URL to
  // the router without the host knowing about specific plugins.
  const navigateToPath = useCallback((path: string) => {
    setLocation(path);
  }, [setLocation]);

  const handleSelectWorkspace = useCallback((id: string) => {
    ensureWorkspaceNodesLoaded(id);
    selectWorkspace(id);
    setLocation(ROUTE_CANVAS);
  }, [ensureWorkspaceNodesLoaded, selectWorkspace, setLocation]);

  useEffect(() => {
    ensureWorkspaceNodesLoaded(activeId);
  }, [activeId, ensureWorkspaceNodesLoaded]);

  const handleCreateWorkspace = useCallback((name: string, folderId?: string) => {
    const trimmed = name.trim() || 'Untitled';
    const id = createWorkspace(name, folderId);
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

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (activeView === 'chat') {
          setLocation(ROUTE_CANVAS);
        } else {
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


  const getWorkspaceRootFolder = useCallback((workspaceId: string) => {
    return workspaces.find((ws) => ws.id === workspaceId)?.rootFolder;
  }, [workspaces]);

  const handleNodeFocusFromChatPage = useCallback((workspaceId: string, nodeId: string) => {
    if (activeId !== workspaceId) {
      selectWorkspace(workspaceId);
    }
    requestNodeFocus(workspaceId, nodeId);
    setLocation(ROUTE_CANVAS);
  }, [activeId, selectWorkspace, requestNodeFocus, setLocation]);

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
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onToggleFolder={toggleFolder}
          onMoveWorkspace={moveWorkspace}
          onReorderWorkspace={reorderWorkspace}
          onReorderFolder={reorderFolder}
          activeNodes={activeNodes}
          onNodeFocus={requestActiveNodeFocus}
          onNodeDelete={requestActiveNodeDelete}
          onNodeRename={requestActiveNodeRename}
          activeView={activeView}
          onEnterChat={enterChatView}
          pluginNavItems={pluginNavItems}
          onNavigate={navigateToPath}
          onExitChat={exitChatView}
        />
        <PulseRouter<ActiveView> activeKey={activeView}>
          <PulseRouterView name='canvas' keepAlive>
            <Workbench
              activeWorkspaceId={activeId}
              workspaces={workspaces}
              controller={workbench}
            />
          </PulseRouterView>
          <PulseRouterView name="chat">
            <ChatPage
              initialWorkspaceId={activeId}
              allWorkspaces={workspaces}
              getWorkspaceNodes={getWorkspaceNodes}
              getWorkspaceRootFolder={getWorkspaceRootFolder}
              onWorkspaceContextRequest={ensureWorkspaceNodesLoaded}
              onExit={exitChatView}
              onNodeFocus={handleNodeFocusFromChatPage}
            />
          </PulseRouterView>
          {pluginRoutes.map((route) => {
            return (
              <PulseRouterView key={route.path} name={route.path}>
                <route.Component />
              </PulseRouterView>
            );
          })}
        </PulseRouter>
      </div>
      <LinkDrawer activeWorkspaceId={activeId} />
    </div>
  );
};

const App = () => (
  <AppShellProvider>
    <ArtifactDrawerProvider>
      <AppContent />
      <ArtifactDrawer />
    </ArtifactDrawerProvider>
  </AppShellProvider>
);

export default App;

import { useCallback, useEffect, useRef, useState } from 'react';

export interface WorkspaceEntry {
  id: string;
  name: string;
  rootFolder?: string;
  folderId?: string;
}

export interface FolderEntry {
  id: string;
  name: string;
  collapsed?: boolean;
}

interface WorkspaceManifest {
  workspaces: WorkspaceEntry[];
  folders?: FolderEntry[];
}

const MANIFEST_ID = '__workspaces__';
const DEFAULT_WORKSPACE: WorkspaceEntry = { id: 'default', name: 'Workspace' };

export const useWorkspaces = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([DEFAULT_WORKSPACE]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [activeId, setActiveId] = useState('default');
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  useEffect(() => {
    const api = window.canvasWorkspace?.store;
    if (!api) return;
    void api.load(MANIFEST_ID).then((res) => {
      if (res.ok && res.data) {
        const manifest = res.data as unknown as WorkspaceManifest;
        if (Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0) {
          setWorkspaces(manifest.workspaces);
          if (Array.isArray(manifest.folders)) {
            setFolders(manifest.folders);
          }
          // Restore last active workspace if still in list
          const savedActiveId = (res.data as unknown as { activeId?: string }).activeId;
          if (savedActiveId && manifest.workspaces.some((w) => w.id === savedActiveId)) {
            setActiveId(savedActiveId);
          }
        }
      } else {
        void api.save(MANIFEST_ID, { workspaces: [DEFAULT_WORKSPACE], folders: [], activeId: 'default' });
      }
    });
  }, []);

  const saveManifest = useCallback(
    (ws: WorkspaceEntry[], newActiveId?: string, newFolders?: FolderEntry[]) => {
      const api = window.canvasWorkspace?.store;
      if (!api) return;
      void api.save(MANIFEST_ID, {
        workspaces: ws,
        folders: newFolders ?? foldersRef.current,
        activeId: newActiveId ?? activeIdRef.current,
      });
    },
    []
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      setActiveId(id);
      setWorkspaces((prev) => {
        saveManifest(prev, id);
        return prev;
      });
    },
    [saveManifest]
  );

  const createWorkspace = useCallback(
    (name: string) => {
      const id = `ws-${Date.now()}`;
      const entry: WorkspaceEntry = { id, name: name.trim() || 'Untitled' };
      setWorkspaces((prev) => {
        const next = [...prev, entry];
        saveManifest(next, id);
        return next;
      });
      setActiveId(id);
      return id;
    },
    [saveManifest]
  );

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setWorkspaces((prev) => {
        const next = prev.map((w) => (w.id === id ? { ...w, name: trimmed } : w));
        saveManifest(next);
        return next;
      });
    },
    [saveManifest]
  );

  const deleteWorkspace = useCallback(
    (id: string) => {
      const api = window.canvasWorkspace?.store;
      setWorkspaces((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((w) => w.id !== id);
        const newActiveId =
          activeIdRef.current === id ? next[0].id : activeIdRef.current;
        saveManifest(next, newActiveId);
        if (activeIdRef.current === id) setActiveId(newActiveId);
        if (api) void api.delete(id);
        return next;
      });
    },
    [saveManifest]
  );

  const setRootFolder = useCallback(
    (id: string, folderPath: string) => {
      setWorkspaces((prev) => {
        const next = prev.map((w) => (w.id === id ? { ...w, rootFolder: folderPath } : w));
        saveManifest(next);
        return next;
      });
    },
    [saveManifest]
  );

  /* ---- Folder CRUD ---- */

  const createFolder = useCallback(
    (name: string) => {
      const id = `folder-${Date.now()}`;
      const entry: FolderEntry = { id, name: name.trim() || 'Untitled Folder' };
      setFolders((prev) => {
        const next = [...prev, entry];
        saveManifest(workspaces, undefined, next);
        return next;
      });
      return id;
    },
    [saveManifest, workspaces]
  );

  const renameFolder = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setFolders((prev) => {
        const next = prev.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
        saveManifest(workspaces, undefined, next);
        return next;
      });
    },
    [saveManifest, workspaces]
  );

  const deleteFolder = useCallback(
    (id: string) => {
      setFolders((prev) => {
        const next = prev.filter((f) => f.id !== id);
        // Un-folder workspaces that were in this folder
        setWorkspaces((wsPrev) => {
          const wsNext = wsPrev.map((w) =>
            w.folderId === id ? { ...w, folderId: undefined } : w
          );
          saveManifest(wsNext, undefined, next);
          return wsNext;
        });
        return next;
      });
    },
    [saveManifest]
  );

  const toggleFolder = useCallback(
    (id: string) => {
      setFolders((prev) => {
        const next = prev.map((f) =>
          f.id === id ? { ...f, collapsed: !f.collapsed } : f
        );
        saveManifest(workspaces, undefined, next);
        return next;
      });
    },
    [saveManifest, workspaces]
  );

  /** Move a workspace into a folder (or to root if folderId is undefined) */
  const moveWorkspace = useCallback(
    (workspaceId: string, folderId: string | undefined) => {
      setWorkspaces((prev) => {
        const next = prev.map((w) =>
          w.id === workspaceId ? { ...w, folderId } : w
        );
        saveManifest(next);
        return next;
      });
    },
    [saveManifest]
  );

  /** Reorder a folder by moving it before another folder (or to end) */
  const reorderFolder = useCallback(
    (folderId: string, beforeFolderId: string | null) => {
      setFolders((prev) => {
        const moving = prev.find((f) => f.id === folderId);
        if (!moving) return prev;
        const without = prev.filter((f) => f.id !== folderId);
        if (beforeFolderId === null) {
          const next = [...without, moving];
          saveManifest(workspaces, undefined, next);
          return next;
        }
        const idx = without.findIndex((f) => f.id === beforeFolderId);
        if (idx === -1) return prev;
        const next = [...without.slice(0, idx), moving, ...without.slice(idx)];
        saveManifest(workspaces, undefined, next);
        return next;
      });
    },
    [saveManifest, workspaces]
  );

  return {
    workspaces,
    folders,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setRootFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolder,
    moveWorkspace,
    reorderFolder,
  };
};

import { useCallback, useEffect, useRef, useState } from 'react';

export interface WorkspaceEntry {
  id: string;
  name: string;
  rootFolder?: string;
}

interface WorkspaceManifest {
  workspaces: WorkspaceEntry[];
}

const MANIFEST_ID = '__workspaces__';
const DEFAULT_WORKSPACE: WorkspaceEntry = { id: 'default', name: 'Workspace' };

export const useWorkspaces = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([DEFAULT_WORKSPACE]);
  const [activeId, setActiveId] = useState('default');
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  useEffect(() => {
    const api = window.canvasWorkspace?.store;
    if (!api) return;
    void api.load(MANIFEST_ID).then((res) => {
      if (res.ok && res.data) {
        const manifest = res.data as unknown as WorkspaceManifest;
        if (Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0) {
          setWorkspaces(manifest.workspaces);
          // Restore last active workspace if still in list
          const savedActiveId = (res.data as unknown as { activeId?: string }).activeId;
          if (savedActiveId && manifest.workspaces.some((w) => w.id === savedActiveId)) {
            setActiveId(savedActiveId);
          }
        }
      } else {
        void api.save(MANIFEST_ID, { workspaces: [DEFAULT_WORKSPACE], activeId: 'default' });
      }
    });
  }, []);

  const saveManifest = useCallback(
    (ws: WorkspaceEntry[], newActiveId?: string) => {
      const api = window.canvasWorkspace?.store;
      if (!api) return;
      void api.save(MANIFEST_ID, {
        workspaces: ws,
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

  return {
    workspaces,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setRootFolder,
  };
};

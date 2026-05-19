/**
 * Right-side drawer that previews an artifact with version history and
 * pin-to-canvas control.
 *
 * Driven by `ArtifactDrawerContext` — any component that calls
 * `openArtifact(workspaceId, artifactId)` causes this drawer to mount
 * and load the requested artifact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ArtifactVersion } from '../../types';
import { useArtifactDrawer } from './ArtifactContext';

const TYPE_LABEL: Record<string, string> = {
  html: 'HTML',
  svg: 'SVG',
  mermaid: 'Mermaid',
};

const WIDTH_STORAGE_KEY = 'canvas-workspace:artifact-drawer-width';
const MIN_DRAWER_WIDTH = 360;
const DEFAULT_DRAWER_WIDTH = 640;

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_DRAWER_WIDTH;
  try {
    const stored = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!stored) return DEFAULT_DRAWER_WIDTH;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed) || parsed < MIN_DRAWER_WIDTH) return DEFAULT_DRAWER_WIDTH;
    return parsed;
  } catch {
    return DEFAULT_DRAWER_WIDTH;
  }
}

function clampDrawerWidth(value: number): number {
  const viewport = typeof window === 'undefined' ? value : window.innerWidth;
  const max = Math.max(MIN_DRAWER_WIDTH, Math.round(viewport * 0.95));
  return Math.min(max, Math.max(MIN_DRAWER_WIDTH, value));
}

export const ArtifactDrawer = () => {
  const { open, close } = useArtifactDrawer();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState<number>(() => clampDrawerWidth(readStoredWidth()));
  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;

  // Load + subscribe whenever the opened (workspace, artifact) pair changes.
  useEffect(() => {
    if (!open) {
      setArtifact(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);

    const refresh = async () => {
      const result = await window.canvasWorkspace.artifacts.get(open.workspaceId, open.artifactId);
      if (cancelled) return;
      if (!result?.ok || !result.artifact) {
        setError(result?.error ?? 'Artifact not found');
        setArtifact(null);
        return;
      }
      setArtifact(result.artifact);
    };

    void refresh();

    const unsubscribe = window.canvasWorkspace.artifacts.onChange((event) => {
      if (event.workspaceId !== open.workspaceId) return;
      if (event.artifactId !== open.artifactId) return;
      if (event.kind === 'delete') {
        setArtifact(null);
        setError('Artifact was deleted');
        return;
      }
      void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  // Re-clamp on viewport resize so a stored width wider than the new viewport
  // doesn't push the drawer off-screen.
  useEffect(() => {
    const onResize = () => setDrawerWidth(prev => clampDrawerWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      // Handle sits on the LEFT edge of a right-anchored drawer, so dragging
      // left should grow the drawer.
      const next = clampDrawerWidth(startWidth + (startX - ev.clientX));
      setDrawerWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, String(drawerWidthRef.current));
      } catch {
        /* localStorage may be unavailable; user preference simply won't persist. */
      }
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const viewedVersion: ArtifactVersion | null = useMemo(() => {
    if (!artifact) return null;
    return (
      artifact.versions.find(v => v.id === artifact.currentVersionId)
      ?? artifact.versions[artifact.versions.length - 1]
      ?? null
    );
  }, [artifact]);

  const handlePin = useCallback(async () => {
    if (!open || !artifact || artifact.pinnedNodeId || pinning) return;
    setPinning(true);
    try {
      const result = await window.canvasWorkspace.artifacts.pinToCanvas(open.workspaceId, open.artifactId, {});
      if (!result.ok) setError(result.error ?? 'Pin failed');
    } finally {
      setPinning(false);
    }
  }, [open, artifact, pinning]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const renderBody = () => {
    if (error) {
      return <div className="artifact-drawer__empty">{error}</div>;
    }
    if (!artifact || !viewedVersion) {
      return <div className="artifact-drawer__empty">Loading…</div>;
    }
    if (artifact.type === 'html') {
      return (
        <iframe
          key={viewedVersion.id}
          className="artifact-drawer__frame"
          srcDoc={viewedVersion.content}
          sandbox="allow-scripts"
          title={artifact.title}
        />
      );
    }
    if (artifact.type === 'svg') {
      return (
        <div
          className="artifact-drawer__svg-host"
          dangerouslySetInnerHTML={{ __html: viewedVersion.content }}
        />
      );
    }
    return <div className="artifact-drawer__empty">Unsupported artifact type</div>;
  };

  return (
    <>
      <div className="artifact-drawer-backdrop" onClick={close} />
      <aside
        className="artifact-drawer"
        role="dialog"
        aria-label="Artifact preview"
        style={{ width: `${drawerWidth}px` }}
      >
        <div
          className="artifact-drawer__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize artifact panel"
          onMouseDown={startResize}
        />
        <div className="artifact-drawer__header">
          <div className="artifact-drawer__title" title={artifact?.title}>
            {artifact?.title ?? 'Artifact'}
          </div>
          {artifact && (
            <span className="artifact-drawer__type-badge">{TYPE_LABEL[artifact.type] ?? artifact.type}</span>
          )}
          <button type="button" className="artifact-drawer__close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        {artifact && artifact.versions.length > 0 && (
          <div className="artifact-drawer__toolbar">
            <div className="artifact-drawer__toolbar-spacer" />
            {artifact.pinnedNodeId ? (
              <span className="artifact-drawer__pinned-badge">Pinned to canvas</span>
            ) : (
              <button
                type="button"
                className="artifact-drawer__action artifact-drawer__action--primary"
                onClick={() => void handlePin()}
                disabled={pinning}
              >
                {pinning ? 'Pinning…' : 'Pin to canvas'}
              </button>
            )}
          </div>
        )}
        <div className="artifact-drawer__body">{renderBody()}</div>
      </aside>
    </>
  );
};

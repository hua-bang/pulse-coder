import { useEffect } from 'react';
import type { CanvasNode } from '../types';

interface Options {
  /** Current canvas workspace id — used as the saveImage target directory. */
  canvasId: string;
  /** True while the canvas is active / visible. Inactive canvases skip paste. */
  active: boolean;
  /** Container element for the canvas; used to compute a default drop position. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Convert screen coords to canvas coords (honours pan/zoom). */
  screenToCanvas: (x: number, y: number, container: HTMLElement) => { x: number; y: number };
  /** Create a node on the canvas. */
  addNode: (type: CanvasNode['type'], x: number, y: number) => CanvasNode;
  /** Update a node after its image has been saved and measured. */
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  /** Make the new image the current selection. */
  onCreated?: (node: CanvasNode) => void;
}

/** Clamp the pasted image to a reasonable default on-canvas size while
 *  preserving its aspect ratio. Very tall/wide images are still viewable
 *  without filling the screen, and small icons keep their native dimensions. */
const MAX_DEFAULT_DIM = 480;

const fitDimensions = (w: number, h: number): { width: number; height: number } => {
  if (w <= 0 || h <= 0) return { width: 320, height: 240 };
  const largest = Math.max(w, h);
  if (largest <= MAX_DEFAULT_DIM) return { width: w, height: h };
  const scale = MAX_DEFAULT_DIM / largest;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
};

const isTypingContext = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
};

/**
 * Listens for `paste` events on the document and, when the clipboard
 * carries an image and the focus is NOT inside an editable field, saves
 * the image to disk and drops it onto the canvas as a new image node.
 *
 * We deliberately skip typing contexts (tiptap editors, inputs) so that
 * pasting an image into a note still lands inside the note's editor via
 * its own `handlePaste` (see `useFileNodeEditor`).
 */
export const useCanvasImagePaste = ({
  canvasId,
  active,
  containerRef,
  screenToCanvas,
  addNode,
  updateNode,
  onCreated,
}: Options) => {
  useEffect(() => {
    if (!active) return;

    const handler = (e: ClipboardEvent) => {
      if (isTypingContext(e.target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find((i) => i.type.startsWith('image/'));
      if (!imageItem) return;
      const blob = imageItem.getAsFile();
      if (!blob) return;
      e.preventDefault();

      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        if (!base64) return;
        const ext = imageItem.type.replace('image/', '').split(';')[0] ?? 'png';
        const api = window.canvasWorkspace?.file;
        if (!api) return;

        const saved = await api.saveImage(canvasId, base64, ext);
        if (!saved.ok || !saved.filePath) return;

        // Measure natural size so the node frames the image correctly.
        const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(fitDimensions(img.naturalWidth, img.naturalHeight));
          img.onerror = () => resolve({ width: 320, height: 240 });
          img.src = dataUrl;
        });

        // Drop at the viewport centre. Using a known-good anchor here
        // beats guessing at the last mouse position (which would lag
        // when the user pastes via keyboard shortcut only).
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const centre = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2, container);
        const x = centre.x - width / 2;
        const y = centre.y - height / 2;

        const node = addNode('image', x, y);
        updateNode(node.id, {
          width,
          height,
          title: saved.fileName ?? 'Image',
          data: { filePath: saved.filePath ?? '' },
        });
        onCreated?.(node);
      };
      reader.readAsDataURL(blob);
    };

    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [active, canvasId, containerRef, screenToCanvas, addNode, updateNode, onCreated]);
};

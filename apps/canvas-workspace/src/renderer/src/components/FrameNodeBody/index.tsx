import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasNode, FrameNodeData } from "../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const FrameNodeBody = ({ node: _node, onUpdate: _onUpdate }: Props) => {
  return <div className="frame-body" />;
};

/* ---- Color picker (rendered in header) ---- */

const COLOR_PRESETS = [
  { name: "Red", value: "#e8615a" },
  { name: "Orange", value: "#e89545" },
  { name: "Yellow", value: "#d4a030" },
  { name: "Green", value: "#3eb889" },
  { name: "Cyan", value: "#35aec2" },
  { name: "Blue", value: "#5594e8" },
  { name: "Purple", value: "#9575d4" },
  { name: "Pink", value: "#e06aa0" },
  { name: "Gray", value: "#8b96a4" }
];

interface ColorPickerProps {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const FrameColorPicker = ({ node, onUpdate }: ColorPickerProps) => {
  const data = node.data as FrameNodeData;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleColorChange = useCallback(
    (color: string) => {
      onUpdate(node.id, { data: { ...data, color } });
      setOpen(false);
    },
    [node.id, data, onUpdate]
  );

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div
      className={`frame-color-trigger${open ? ' frame-color-trigger--open' : ''}`}
      ref={triggerRef}
      title="Frame color"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="frame-color-dot"
        style={{ backgroundColor: data.color }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {open && (
        <div className="frame-color-popover frame-color-popover--open">
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset.name}
              className={`frame-color-swatch${data.color === preset.value ? ' frame-color-swatch--active' : ''}`}
              style={{ backgroundColor: preset.value }}
              title={preset.name}
              onClick={(e) => {
                e.stopPropagation();
                handleColorChange(preset.value);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

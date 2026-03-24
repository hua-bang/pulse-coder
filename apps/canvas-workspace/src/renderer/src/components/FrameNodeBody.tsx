import { useCallback } from "react";
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
  { name: "Red", value: "#e03e3e" },
  { name: "Orange", value: "#d9730d" },
  { name: "Yellow", value: "#cb912f" },
  { name: "Green", value: "#0f7b6c" },
  { name: "Cyan", value: "#2e9e9e" },
  { name: "Blue", value: "#2383e2" },
  { name: "Purple", value: "#9065b0" },
  { name: "Pink", value: "#c84c8a" },
  { name: "Gray", value: "#787774" }
];

interface ColorPickerProps {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const FrameColorPicker = ({ node, onUpdate }: ColorPickerProps) => {
  const data = node.data as FrameNodeData;

  const handleColorChange = useCallback(
    (color: string) => {
      onUpdate(node.id, { data: { ...data, color } });
    },
    [node.id, data, onUpdate]
  );

  return (
    <div className="frame-color-trigger" title="Frame color">
      <div className="frame-color-dot" style={{ backgroundColor: data.color }} />
      <div className="frame-color-popover">
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
    </div>
  );
};

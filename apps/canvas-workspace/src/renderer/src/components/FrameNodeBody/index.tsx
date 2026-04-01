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

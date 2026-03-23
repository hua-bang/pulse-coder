import { useCallback } from "react";
import type { CanvasNode, FrameNodeData } from "../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const COLOR_PRESETS = [
  { name: "Purple", value: "rgba(144, 101, 176, 0.10)" },
  { name: "Blue", value: "rgba(35, 131, 226, 0.10)" },
  { name: "Green", value: "rgba(15, 123, 108, 0.10)" },
  { name: "Orange", value: "rgba(217, 115, 13, 0.10)" },
  { name: "Red", value: "rgba(224, 62, 62, 0.10)" },
  { name: "Gray", value: "rgba(55, 53, 47, 0.06)" }
];

export const FrameNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as FrameNodeData;

  const handleColorChange = useCallback(
    (color: string) => {
      onUpdate(node.id, { data: { ...data, color } });
    },
    [node.id, data, onUpdate]
  );

  return (
    <div className="frame-body" style={{ backgroundColor: data.color }}>
      <div className="frame-colors">
        {COLOR_PRESETS.map((preset) => (
          <button
            key={preset.name}
            className={`frame-color-swatch${data.color === preset.value ? ' frame-color-swatch--active' : ''}`}
            style={{ backgroundColor: preset.value.replace('0.10', '0.45') }}
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

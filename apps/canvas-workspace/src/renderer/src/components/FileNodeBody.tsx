import { useCallback } from "react";
import type { CanvasNode, FileNodeData } from "../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const FileNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as FileNodeData;

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onUpdate(node.id, {
        data: { ...data, content: e.target.value }
      });
    },
    [onUpdate, node.id, data]
  );

  const handlePathChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(node.id, {
        data: { ...data, filePath: e.target.value }
      });
    },
    [onUpdate, node.id, data]
  );

  return (
    <div className="file-node-body">
      <div className="file-path-row">
        <input
          className="file-path-input"
          type="text"
          placeholder="file path..."
          value={data.filePath}
          onChange={handlePathChange}
          spellCheck={false}
        />
      </div>
      <textarea
        className="file-editor"
        value={data.content}
        onChange={handleContentChange}
        placeholder="Start typing or paste content..."
        spellCheck={false}
      />
    </div>
  );
};

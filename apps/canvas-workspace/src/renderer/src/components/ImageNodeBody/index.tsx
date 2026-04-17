import { useCallback } from 'react';
import './index.css';
import type { CanvasNode, ImageNodeData } from '../../types';

interface Props {
  node: CanvasNode;
  onSelect: (id: string) => void;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
}

/**
 * Image node body. Renders the saved image from disk and makes the whole
 * surface a drag handle — the outer CanvasNodeView hides the header for
 * image nodes so there is no other grip to reach for.
 */
export const ImageNodeBody = ({ node, onSelect, onDragStart }: Props) => {
  const data = node.data as ImageNodeData;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      onSelect(node.id);
      onDragStart(e, node);
    },
    [node, onSelect, onDragStart],
  );

  return (
    <div className="image-node-body" onMouseDown={handleMouseDown}>
      {data.filePath ? (
        <img
          className="image-node-img"
          src={`file://${data.filePath}`}
          alt={node.title}
          draggable={false}
        />
      ) : (
        <div className="image-node-empty">No image</div>
      )}
    </div>
  );
};

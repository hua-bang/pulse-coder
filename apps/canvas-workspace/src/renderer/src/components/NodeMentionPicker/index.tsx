import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import type { CanvasNode, FileNodeData } from '../../types';

interface Props {
  nodes: CanvasNode[];
  onSelect: (node: CanvasNode) => void;
  onClose: () => void;
}

const MAX_RESULTS = 20;

export const NodeMentionPicker = ({ nodes, onSelect, onClose }: Props) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo((): CanvasNode[] => {
    if (!query.trim()) return nodes.slice(0, MAX_RESULTS);
    const q = query.toLowerCase();
    return nodes
      .filter((n) => {
        if (n.title.toLowerCase().includes(q)) return true;
        if (n.type === 'file') {
          const fp = (n.data as FileNodeData).filePath ?? '';
          return fp.toLowerCase().includes(q);
        }
        return false;
      })
      .slice(0, MAX_RESULTS);
  }, [query, nodes]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]);
        return;
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  return (
    <div className="node-mention-backdrop" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
      <div className="node-mention-picker" onClick={(e) => e.stopPropagation()}>
        <div className="node-mention-header">
          <span className="node-mention-label">@ 引用节点</span>
          <kbd className="node-mention-kbd">Ctrl/⌘+2</kbd>
        </div>
        <div className="node-mention-search">
          <input
            ref={inputRef}
            type="text"
            className="node-mention-input"
            placeholder="搜索节点名称..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="node-mention-list">
          {filtered.length === 0 ? (
            <div className="node-mention-empty">无匹配节点</div>
          ) : (
            filtered.map((node, idx) => {
              const filePath = node.type === 'file' ? (node.data as FileNodeData).filePath : undefined;
              const fileName = filePath ? filePath.split('/').pop() : undefined;
              return (
                <div
                  key={node.id}
                  className={`node-mention-item${idx === selectedIndex ? ' selected' : ''}`}
                  onClick={() => onSelect(node)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className={`node-mention-badge node-mention-badge--${node.type}`}>
                    {node.type}
                  </span>
                  <span className="node-mention-title">{node.title}</span>
                  {fileName && <span className="node-mention-path">{fileName}</span>}
                </div>
              );
            })
          )}
        </div>
        <div className="node-mention-hint">
          <span>↑↓ 导航</span>
          <span>↵ 插入</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
};

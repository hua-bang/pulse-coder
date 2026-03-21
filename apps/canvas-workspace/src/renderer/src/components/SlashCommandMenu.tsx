import { useEffect, useRef } from 'react';

export interface SlashCommandDef {
  id: string;
  label: string;
  desc: string;
  icon: string;
}

interface Props {
  x: number;
  y: number;
  selectedIndex: number;
  items: SlashCommandDef[];
  onSelect: (cmd: SlashCommandDef) => void;
  onClose: () => void;
}

export const SlashCommandMenu = ({
  x,
  y,
  selectedIndex,
  items,
  onSelect,
  onClose,
}: Props) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Scroll active item into view
  useEffect(() => {
    const el = menuRef.current?.querySelector('.slash-menu-item--active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (items.length === 0) return null;

  // Keep the menu inside the viewport horizontally
  const viewportW = window.innerWidth;
  const menuW = 220;
  const left = Math.min(x, viewportW - menuW - 8);

  return (
    <div
      ref={menuRef}
      className="slash-menu"
      style={{ position: 'fixed', left, top: y + 6, zIndex: 9000 }}
    >
      <div className="slash-menu-header">BLOCKS</div>
      {items.map((item, i) => (
        <button
          key={item.id}
          className={`slash-menu-item${i === selectedIndex ? ' slash-menu-item--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
        >
          <span className="slash-menu-icon">{item.icon}</span>
          <span className="slash-menu-label">
            <strong>{item.label}</strong>
            <small>{item.desc}</small>
          </span>
        </button>
      ))}
    </div>
  );
};

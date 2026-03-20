import { useEffect, useRef } from "react";

interface Props {
  x: number;
  y: number;
  onCreate: (type: "file" | "terminal") => void;
  onClose: () => void;
}

export const NodeContextMenu = ({ x, y, onCreate, onClose }: Props) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      window.addEventListener("click", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-title">Create Node</div>
      <button
        className="context-menu-item"
        onClick={() => onCreate("file")}
      >
        <span className="context-menu-icon">{"\u2756"}</span>
        <span className="context-menu-label">
          <strong>File</strong>
          <small>Edit a local file</small>
        </span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => onCreate("terminal")}
      >
        <span className="context-menu-icon">{"\u25B6"}</span>
        <span className="context-menu-label">
          <strong>Terminal</strong>
          <small>Run shell commands</small>
        </span>
      </button>
    </div>
  );
};

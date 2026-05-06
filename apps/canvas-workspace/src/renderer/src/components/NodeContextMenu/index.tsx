import "./index.css";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
  x: number;
  y: number;
  mode?: "create" | "mindmap";
  onCreate?: (type: "file" | "terminal" | "frame" | "agent" | "text" | "iframe" | "mindmap") => void;
  onExportImage?: () => void;
  onClose: () => void;
}

export const NodeContextMenu = ({ x, y, mode = "create", onCreate, onExportImage, onClose }: Props) => {
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

  const menu = (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {mode === "mindmap" ? (
        <>
          <div className="context-menu-title">Mindmap</div>
          <button
            className="context-menu-item"
            onClick={() => onExportImage?.()}
          >
            <span className="context-menu-icon">{"\u21E9"}</span>
            <span className="context-menu-label">
              <strong>Export as image</strong>
              <small>Save this mindmap as a PNG</small>
            </span>
          </button>
        </>
      ) : (
        <>
          <div className="context-menu-title">Create Node</div>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("text")}
          >
            <span className="context-menu-icon">{"\u0041"}</span>
            <span className="context-menu-label">
              <strong>Text</strong>
              <small>Free-form text label</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("file")}
          >
            <span className="context-menu-icon">{"\u2756"}</span>
            <span className="context-menu-label">
              <strong>Note</strong>
              <small>Markdown note card</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("terminal")}
          >
            <span className="context-menu-icon">{"\u25B6"}</span>
            <span className="context-menu-label">
              <strong>Terminal</strong>
              <small>Run shell commands</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("frame")}
          >
            <span className="context-menu-icon">{"\u25A1"}</span>
            <span className="context-menu-label">
              <strong>Frame</strong>
              <small>Visual container group</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("iframe")}
          >
            <span className="context-menu-icon">{"\u232C"}</span>
            <span className="context-menu-label">
              <strong>Link</strong>
              <small>Embed a web page</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("agent")}
          >
            <span className="context-menu-icon">{"\u2726"}</span>
            <span className="context-menu-label">
              <strong>Agent</strong>
              <small>Launch a coding agent</small>
            </span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => onCreate?.("mindmap")}
          >
            <span className="context-menu-icon">{"✿"}</span>
            <span className="context-menu-label">
              <strong>Mindmap</strong>
              <small>Branching topic tree</small>
            </span>
          </button>
        </>
      )}
    </div>
  );

  return createPortal(menu, document.body);
};

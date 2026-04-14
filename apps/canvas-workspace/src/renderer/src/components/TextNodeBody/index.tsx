import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, TextNodeData } from "../../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

/**
 * TLDRAW-style text node body.
 *
 * Renders a contentEditable plain-text surface. Styling (text color, bg color,
 * font size) is read from `node.data` and persisted via `onUpdate`. The
 * parent CanvasNodeView disables dragging on mousedown inside `.node-body`,
 * so caret placement and selection behave like a normal editor.
 *
 * The DOM text is only rewritten from props when it differs from the current
 * innerText — otherwise every keystroke would reset the caret to position 0
 * because React re-renders on each `onUpdate`.
 */
export const TextNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as TextNodeData;
  const ref = useRef<HTMLDivElement>(null);

  // Only sync DOM → when external content diverges (e.g. undo/redo, CLI edit,
  // duplicate). Skipping this when the ref already matches avoids wiping the
  // user's caret position on every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerText !== data.content) {
      el.innerText = data.content;
    }
  }, [data.content]);

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const next = e.currentTarget.innerText;
      if (next !== data.content) {
        onUpdate(node.id, { data: { ...data, content: next } });
      }
    },
    [node.id, data, onUpdate]
  );

  // Autofocus the editor when the node is first created with empty content,
  // so typing works immediately without an extra click.
  useEffect(() => {
    if (data.content === "" && ref.current) {
      const el = ref.current;
      // Defer one tick so the element is attached and any drag/click finishes.
      const t = setTimeout(() => el.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={ref}
      className="text-node-body"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
      style={{
        color: data.textColor,
        backgroundColor: data.backgroundColor,
        fontSize: data.fontSize ?? 18,
      }}
      data-placeholder="Type something…"
    />
  );
};

/* ---- Color pickers (rendered in header) ---- */

// TLDRAW-ish palette for text colors. Black/dark first, then saturated hues,
// then white for use on dark backgrounds.
const TEXT_COLOR_PRESETS: Array<{ name: string; value: string }> = [
  { name: "Black", value: "#1f2328" },
  { name: "Gray", value: "#6b7280" },
  { name: "Red", value: "#e03131" },
  { name: "Orange", value: "#f08c00" },
  { name: "Yellow", value: "#e8b800" },
  { name: "Green", value: "#2f9e44" },
  { name: "Blue", value: "#1c7ed6" },
  { name: "Purple", value: "#7048e8" },
  { name: "White", value: "#ffffff" },
];

// Background presets lead with "transparent" (chrome-free label) and follow
// with soft pastels that read well against the black default text color.
const BG_COLOR_PRESETS: Array<{ name: string; value: string }> = [
  { name: "None", value: "transparent" },
  { name: "White", value: "#ffffff" },
  { name: "Gray", value: "#e9ecef" },
  { name: "Red", value: "#ffe3e3" },
  { name: "Orange", value: "#ffe8cc" },
  { name: "Yellow", value: "#fff3bf" },
  { name: "Green", value: "#d3f9d8" },
  { name: "Blue", value: "#d0ebff" },
  { name: "Purple", value: "#e5dbff" },
];

type PickerKind = "text" | "bg";

const TextColorTrigger = ({
  node,
  onUpdate,
  kind,
}: {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  kind: PickerKind;
}) => {
  const data = node.data as TextNodeData;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  const currentValue = kind === "text" ? data.textColor : data.backgroundColor;
  const presets = kind === "text" ? TEXT_COLOR_PRESETS : BG_COLOR_PRESETS;
  const title = kind === "text" ? "Text color" : "Background color";

  const handlePick = useCallback(
    (value: string) => {
      const patch: Partial<TextNodeData> =
        kind === "text" ? { textColor: value } : { backgroundColor: value };
      onUpdate(node.id, { data: { ...data, ...patch } });
      setOpen(false);
    },
    [kind, node.id, data, onUpdate]
  );

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const isTransparent = currentValue === "transparent";

  return (
    <div
      ref={triggerRef}
      className={`text-color-trigger${open ? " text-color-trigger--open" : ""}`}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`text-color-dot${isTransparent ? " text-color-dot--transparent" : ""}`}
        style={{ backgroundColor: isTransparent ? undefined : currentValue }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {kind === "text" && <span className="text-color-dot-glyph">A</span>}
      </div>
      {open && (
        <div className="text-color-popover text-color-popover--open">
          {presets.map((preset) => {
            const active = currentValue === preset.value;
            const isNone = preset.value === "transparent";
            return (
              <button
                key={preset.name}
                className={
                  "text-color-swatch" +
                  (active ? " text-color-swatch--active" : "") +
                  (isNone ? " text-color-swatch--none" : "")
                }
                style={{
                  backgroundColor: isNone ? undefined : preset.value,
                }}
                title={preset.name}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePick(preset.value);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

export const TextColorPicker = ({
  node,
  onUpdate,
}: {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}) => (
  <>
    <TextColorTrigger node={node} onUpdate={onUpdate} kind="text" />
    <TextColorTrigger node={node} onUpdate={onUpdate} kind="bg" />
  </>
);

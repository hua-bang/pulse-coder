import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import "./index.css";
import type { CanvasNode, TextNodeData } from "../../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
}

/* ---------------------------------------------------------------------------
 * Markdown rendering
 *
 * `html: false` prevents users from injecting raw HTML through the contenteditable
 * surface. `breaks: true` turns a single newline into <br>, which matches what
 * users expect when typing into a plain text box.
 *
 * CommonMark doesn't cover underline, so `++text++` is a small extension handled
 * by a post-process substitution — narrow regex (no line-break, no nested `+`)
 * keeps it from catching `x += y` style text.
 * ------------------------------------------------------------------------- */
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
});

const UNDERLINE_RE = /\+\+([^+\n][^\n]*?)\+\+/g;

function renderMarkdown(src: string): string {
  if (!src) return "";
  const html = md.render(src);
  return html.replace(UNDERLINE_RE, "<u>$1</u>");
}

/* ---------------------------------------------------------------------------
 * TLDRAW-style text node body.
 *
 * UX model:
 *  - Idle: no card chrome. Content renders as formatted markdown on the canvas.
 *  - Click + drag: moves the node.
 *  - Double-click: enters editing. The body swaps to plain-text contenteditable
 *    (raw markdown source) so the user can edit the syntax directly.
 *  - Blur / Escape / deselect: exits editing, re-renders as HTML.
 *
 * Size:
 *  - When `data.autoSize !== false` (default), CSS `width: max-content` drives
 *    the wrapper's rendered size. useLayoutEffect persists the measured size
 *    back to node.width / node.height so Canvas hit-testing & frame containment
 *    stay accurate.
 *  - When the user drags a resize handle, CanvasNodeView flips `autoSize` to
 *    false. The wrapper honors node.width/height as a fixed frame, text wraps
 *    inside, and overflowing content is clipped by the .node-body. The measure
 *    effect is a no-op in this mode — the user's drag is authoritative.
 * ------------------------------------------------------------------------- */
export const TextNodeBody = ({ node, onUpdate, isSelected, onSelect, onDragStart }: Props) => {
  const data = node.data as TextNodeData;
  const autoSize = data.autoSize !== false;
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  // Keep DOM content in sync with `data.content`. Editing shows raw markdown
  // (innerText), display mode shows rendered HTML (innerHTML). We only write
  // when the rendered form diverges from what's already there — otherwise every
  // keystroke would clobber the caret position.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (editing) {
      if (el.innerText !== data.content) {
        el.innerText = data.content;
      }
    } else {
      const html = renderMarkdown(data.content);
      if (el.innerHTML !== html) {
        el.innerHTML = html;
      }
    }
  }, [editing, data.content]);

  // Auto-size the wrapper to fit content. In manual mode the user's dragged
  // dimensions are authoritative, so we don't write anything back — the
  // .node-body clips any overflow (CSS), matching tldraw's "fixed frame" feel.
  useLayoutEffect(() => {
    if (!autoSize) return;
    const el = ref.current;
    if (!el) return;
    const measuredW = Math.max(40, Math.ceil(el.offsetWidth));
    const measuredH = Math.max(28, Math.ceil(el.offsetHeight));
    if (
      Math.abs(measuredW - node.width) > 1 ||
      Math.abs(measuredH - node.height) > 1
    ) {
      onUpdate(node.id, { width: measuredW, height: measuredH });
    }
  });

  // First mount: empty content → drop straight into editing mode so typing
  // works immediately. Skipped for nodes that already have content (paste,
  // duplicate, reload from storage).
  useEffect(() => {
    if (data.content === "" && ref.current) {
      setEditing(true);
      const el = ref.current;
      const t = setTimeout(() => el.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Deselection finalizes the edit — matches tldraw's click-away-to-commit feel.
  useEffect(() => {
    if (!isSelected && editing) {
      setEditing(false);
      ref.current?.blur();
    }
  }, [isSelected, editing]);

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const next = e.currentTarget.innerText;
      if (next !== data.content) {
        onUpdate(node.id, { data: { ...data, content: next } });
      }
    },
    [node.id, data, onUpdate]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (editing) {
        // Caret placement / text selection — don't drag.
        e.stopPropagation();
        return;
      }
      onSelect(node.id);
      onDragStart(e, node);
    },
    [editing, node, onSelect, onDragStart]
  );

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
    // contentEditable=true is applied after the state flush; focus once it's
    // in the DOM so the caret lands where the user double-clicked.
    setTimeout(() => ref.current?.focus(), 0);
  }, []);

  const handleBlur = useCallback(() => {
    setEditing(false);
  }, []);

  // Cmd/Ctrl + B / I / U wraps the current selection with a markdown marker
  // (`**`, `*`, `++`). The wrapping tokens become part of the source text so
  // markdown-it renders them as <strong>, <em>, <u> once the user exits edit
  // mode.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ref.current?.blur();
        setEditing(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        let marker: string | null = null;
        if (key === "b") marker = "**";
        else if (key === "i") marker = "*";
        else if (key === "u") marker = "++";
        if (marker) {
          e.preventDefault();
          const el = ref.current;
          if (!el) return;
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const range = sel.getRangeAt(0);
          if (!el.contains(range.commonAncestorContainer)) return;
          const selectedText = range.toString();
          const wrapped = `${marker}${selectedText}${marker}`;
          range.deleteContents();
          const textNode = document.createTextNode(wrapped);
          range.insertNode(textNode);
          // Caret placement: if user had a selection, park the caret after
          // the wrapped text. If empty selection, put it between the markers
          // so they can start typing the styled text.
          const after = document.createRange();
          if (selectedText) {
            after.setStartAfter(textNode);
          } else {
            after.setStart(textNode, marker.length);
          }
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
          const next = el.innerText;
          if (next !== data.content) {
            onUpdate(node.id, { data: { ...data, content: next } });
          }
        }
      }
    },
    [node.id, data, onUpdate]
  );

  return (
    <div
      ref={ref}
      className={`text-node-body${editing ? " text-node-body--editing" : ""}`}
      contentEditable={editing}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={editing ? handleInput : undefined}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onBlur={editing ? handleBlur : undefined}
      onKeyDown={editing ? handleKeyDown : undefined}
      style={{
        color: data.textColor,
        backgroundColor: data.backgroundColor,
        fontSize: data.fontSize ?? 18,
      }}
      data-placeholder="Type something…"
    />
  );
};

/* ---- Color pickers (rendered in the hover/selected header) ---- */

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

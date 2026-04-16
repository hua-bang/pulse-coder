import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
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
 * TLDRAW-style text node body (tiptap-backed).
 *
 * Design:
 *  - Tiptap gives true WYSIWYG, robust IME handling, and all the markdown
 *    keyboard shortcuts for free. Content is stored as markdown in
 *    node.data.content via the `tiptap-markdown` bridge.
 *  - Idle state: editor is non-editable. Clicks hit our outer wrapper and
 *    start a drag; the node feels like a label.
 *  - Editing: double-click flips the editor to editable and focuses it.
 *    Blur, Escape, or deselection commits the edit.
 *
 * Size:
 *  - `data.autoSize !== false` (default) → wrapper tracks content via CSS
 *    `max-content`. useLayoutEffect persists the measured size so Canvas
 *    hit-testing / frame containment stay in sync.
 *  - After a resize-handle drag (CanvasNodeView flips `autoSize` to false),
 *    node.width/height becomes a fixed frame; text wraps inside and the
 *    .node-body clips overflow.
 * ------------------------------------------------------------------------- */
export const TextNodeBody = ({ node, onUpdate, isSelected, onSelect, onDragStart }: Props) => {
  const data = node.data as TextNodeData;
  const autoSize = data.autoSize !== false;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  // Refs that onUpdate / editor callbacks need without re-registering on every
  // keystroke. This is the same pattern useFileNodeEditor uses for the note
  // editor.
  const dataRef = useRef(data);
  dataRef.current = data;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const prevContentRef = useRef(data.content);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const editor = useEditor({
    extensions: [
      // StarterKit bundles an inline Underline; we swap it for the explicit
      // extension so keyboard shortcuts (Cmd+U) and serialization behave the
      // same as the rest of the app.
      StarterKit.configure({ underline: false }),
      Underline,
      // `showOnlyWhenEditable: false` — an empty text node is otherwise
      // invisible on the canvas (transparent bg, no chrome). The placeholder
      // doubles as a "there's a node here" marker at rest.
      Placeholder.configure({
        placeholder: "Double-click to edit",
        showOnlyWhenEditable: false,
      }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: true }),
    ],
    content: data.content || "",
    editable: false,
    onUpdate: ({ editor }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = ((editor.storage as any)?.markdown?.getMarkdown() as string | undefined) ?? "";
      if (md === dataRef.current.content) return;
      prevContentRef.current = md;
      onUpdateRef.current(nodeIdRef.current, {
        data: { ...dataRef.current, content: md },
      });
    },
    onBlur: () => {
      setEditing(false);
    },
  });

  // Sync the editable flag with our `editing` state. Tiptap's options are
  // captured once, so we toggle imperatively.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editing);
  }, [editor, editing]);

  // Ensure content is correctly loaded on mount and handle external content
  // changes (undo/redo, CLI edit, duplicate-paste). On first mount we always
  // re-apply via setContent to guarantee line breaks survive — the Markdown
  // extension's onBeforeCreate hook (which parses initial `content`) can be
  // bypassed by tiptap-react's EditorInstanceManager lifecycle (e.g. when
  // scheduleDestroy re-creates the editor with raw options).  On subsequent
  // renders we only call setContent when data.content actually changed.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!editor) return;
    const isMount = !mountedRef.current;
    if (isMount) mountedRef.current = true;
    if (!isMount && data.content === prevContentRef.current) return;
    prevContentRef.current = data.content;
    // `emitUpdate: false` avoids firing our onUpdate → onUpdate loop.
    editor.commands.setContent(data.content || "", { emitUpdate: false });
  }, [editor, data.content]);

  // First-mount: empty-content nodes drop straight into editing so typing
  // works immediately without an extra double-click.
  useEffect(() => {
    if (!editor) return;
    if (data.content === "") {
      setEditing(true);
      // Defer focus until editable=true has applied to the DOM.
      const t = setTimeout(() => editor.commands.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deselection commits the edit — matches tldraw's click-away-to-finalize feel.
  useEffect(() => {
    if (!isSelected && editing) {
      setEditing(false);
      editor?.commands.blur();
    }
  }, [isSelected, editing, editor]);

  // Auto-size the wrapper to fit content. Height ALWAYS tracks content so a
  // text node can never clip or scroll (prosemirror's auto-scroll-into-view
  // would otherwise push the top of the text off-screen). Width is
  // content-driven only while `autoSize` is true; once the user drags the
  // right handle it becomes the authoritative wrap width.
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const measuredW = Math.max(40, Math.ceil(el.offsetWidth));
    const measuredH = Math.max(28, Math.ceil(el.offsetHeight));
    const patch: Partial<CanvasNode> = {};
    if (autoSize && Math.abs(measuredW - node.width) > 1) {
      patch.width = measuredW;
    }
    if (Math.abs(measuredH - node.height) > 1) {
      patch.height = measuredH;
    }
    if (patch.width !== undefined || patch.height !== undefined) {
      onUpdate(node.id, patch);
    }
  });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (editing) {
        // Let prosemirror handle caret placement / text selection; just make
        // sure the wrapper's drag listeners don't fire.
        e.stopPropagation();
        return;
      }
      onSelect(node.id);
      onDragStart(e, node);
    },
    [editing, node, onSelect, onDragStart]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editing) return;
      setEditing(true);
      setTimeout(() => editor?.commands.focus(), 0);
    },
    [editing, editor]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        editor?.commands.blur();
        setEditing(false);
      }
    },
    [editor]
  );

  return (
    <div
      ref={wrapperRef}
      className={`text-node-body${editing ? " text-node-body--editing" : ""}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      style={{
        color: data.textColor,
        backgroundColor: data.backgroundColor,
        fontSize: data.fontSize ?? 18,
      }}
    >
      <EditorContent editor={editor} />
    </div>
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
      // preventDefault on mousedown keeps the editor focused when the user
      // reaches for a color while editing — no exit-and-re-enter ceremony.
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
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
                onMouseDown={(e) => e.preventDefault()}
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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './index.css';
import type { CanvasNode, MindmapNodeData, MindmapTopic } from '../../types';
import { genTopicId } from '../../utils/nodeFactory';
import {
  deleteTopic,
  findParent,
  findTopicPath,
  insertChild,
  isDescendant,
  layoutMindmap,
  moveTopic,
  setTopicText,
  toggleCollapsed,
  type DropTarget,
  type LaidOutTopic,
} from '../../utils/mindmapLayout';

interface Props {
  node: CanvasNode;
  isSelected: boolean;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  /** Called when any topic pill inside the mindmap receives a mouse
   *  selection. The mindmap itself is a canvas node; bubbling up this
   *  selection keeps the outer canvas-level selection in sync (so
   *  shortcuts like Delete that act on the selected canvas node hit
   *  the right target). */
  onSelectNode: (id: string) => void;
  /** Dimension-only update that skips history. We call this when the
   *  rendered tree's bounding box no longer matches the canvas node's
   *  width/height — typing a character grows the owning topic's slot,
   *  which in turn grows the whole mindmap; we want that resize to
   *  reconcile silently rather than spamming undo history. */
  onAutoResize: (id: string, width: number, height: number) => void;
}

/**
 * Heptabase-style mindmap body.
 *
 * Structure lives in `node.data.root` (a recursive `MindmapTopic` tree).
 * Every render runs `layoutMindmap` to produce pill positions and branch
 * paths in mindmap-local coords, then this component draws them in an
 * absolutely-positioned inner canvas. The node's own width/height frames
 * the viewport — oversized mindmaps scroll inside the node.
 *
 * Keyboard model (while a topic is focused):
 *   Tab            → add child and enter edit on it
 *   Enter          → add sibling (ignored on root — root has no siblings,
 *                    so Enter on the root adds a child instead)
 *   Shift+Tab      → unindent (become a sibling of the current parent)
 *   Backspace      → delete when text is empty; otherwise normal edit
 *   Space          → toggle collapse on a topic with children
 *   Arrow keys     → move selection along the geometric neighbor
 *   Esc            → exit edit mode but keep the topic selected
 *
 * Editing: single click selects a topic, double click or typing a char
 * while selected enters edit mode. Commit on blur / Enter (Enter on a
 * non-root topic also spawns a sibling); Esc cancels without saving.
 */
export const MindmapNodeBody = ({ node, isSelected, onUpdate, onSelectNode, onAutoResize }: Props) => {
  const data = node.data as MindmapNodeData;
  const root = data.root;

  const [selectedId, setSelectedId] = useState<string>(root.id);
  const [editingId, setEditingId] = useState<string | null>(null);
  // When the user creates a topic via Tab/Enter we want to jump to edit
  // mode on the new topic as soon as it renders. We stash the id here
  // and clear it once we've moved the focus.
  const pendingFocusRef = useRef<string | null>(null);

  const layout = useMemo(() => layoutMindmap(root), [root]);

  const padding = 16;
  const wantedWidth = Math.max(140, Math.ceil(layout.width + padding * 2));
  const wantedHeight = Math.max(60, Math.ceil(layout.height + padding * 2));
  const viewportWidth = Math.max(0, node.width - padding * 2);
  const viewportHeight = Math.max(0, node.height - padding * 2);

  // Mindmap nodes auto-size to their content. Whenever the computed
  // bounding box disagrees with the canvas node's current dimensions
  // (because the user typed, added, deleted, or folded a topic) we
  // reconcile via `onAutoResize`, which bypasses the undo history so
  // the size change rides along with whatever mutation just fired.
  useEffect(() => {
    if (node.width !== wantedWidth || node.height !== wantedHeight) {
      onAutoResize(node.id, wantedWidth, wantedHeight);
    }
  }, [wantedWidth, wantedHeight, node.id, node.width, node.height, onAutoResize]);

  // Keep selection valid when the tree mutates (delete removed the
  // selected node, external update rebuilt ids, etc).
  useEffect(() => {
    const stillExists = findTopicPath(root, selectedId);
    if (!stillExists) setSelectedId(root.id);
  }, [root, selectedId]);

  /* ---- Mutation helpers ---- */

  const applyRoot = useCallback(
    (nextRoot: MindmapTopic) => {
      onUpdate(node.id, {
        data: {
          ...data,
          root: nextRoot,
          rev: (data.rev ?? 0) + 1,
        },
      });
    },
    [data, node.id, onUpdate],
  );

  const addChild = useCallback(
    (parentId: string, afterId?: string) => {
      const id = genTopicId();
      const topic: MindmapTopic = { id, text: '', children: [] };
      applyRoot(insertChild(root, parentId, topic, afterId));
      pendingFocusRef.current = id;
    },
    [applyRoot, root],
  );

  const addSibling = useCallback(
    (siblingId: string) => {
      if (siblingId === root.id) {
        addChild(root.id);
        return;
      }
      const parent = findParent(root, siblingId);
      if (!parent) return;
      addChild(parent.id, siblingId);
    },
    [addChild, root],
  );

  const unindentTopic = useCallback(
    (topicId: string) => {
      if (topicId === root.id) return;
      const parent = findParent(root, topicId);
      if (!parent || parent.id === root.id) return; // already top level
      const grandparent = findParent(root, parent.id);
      if (!grandparent) return;

      // Capture the topic BEFORE removing it so we can re-insert the
      // same subtree under its grandparent.
      const path = findTopicPath(root, topicId);
      const original = path?.[path.length - 1];
      if (!original) return;

      const removed = deleteTopic(root, topicId);
      if (!removed) return;
      const next = insertChild(removed.root, grandparent.id, original, parent.id);
      applyRoot(next);
      pendingFocusRef.current = topicId;
    },
    [applyRoot, root],
  );

  const removeTopic = useCallback(
    (topicId: string) => {
      if (topicId === root.id) return;
      const result = deleteTopic(root, topicId);
      if (!result) return;
      applyRoot(result.root);
      setSelectedId(result.nextFocusId);
      setEditingId(null);
    },
    [applyRoot, root],
  );

  const renameTopic = useCallback(
    (topicId: string, text: string) => {
      if (findTopicPath(root, topicId)?.slice(-1)[0].text === text) return;
      applyRoot(setTopicText(root, topicId, text));
    },
    [applyRoot, root],
  );

  const toggle = useCallback(
    (topicId: string) => {
      applyRoot(toggleCollapsed(root, topicId));
    },
    [applyRoot, root],
  );

  /* ---- Drag-reorder ---- */

  // While the user is dragging a topic, `reorder` carries the source id
  // and the live drop target (or null when the cursor isn't over a valid
  // landing spot). We render visual cues from this state and apply the
  // mutation on mouseup.
  const [reorder, setReorder] = useState<{
    sourceId: string;
    target: DropTarget | null;
  } | null>(null);

  const beginReorder = useCallback(
    (sourceId: string, startEvent: React.MouseEvent) => {
      // Root can't be moved (no parent to detach from). Bail early so we
      // don't even attach window listeners — root's onMouseDown still
      // selects normally.
      if (sourceId === root.id) return;
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      const THRESHOLD = 5; // px of movement before we commit to "drag"
      let started = false;
      // Snapshot the root reference so the listeners always validate
      // against the tree the drag began with — applyRoot replaces the
      // node's data via parent state, but our captured `root` is fine
      // for hit-tests because target ids stay stable mid-drag.
      const dragRoot = root;

      const hitTest = (clientX: number, clientY: number): DropTarget | null => {
        const stack = document.elementsFromPoint(clientX, clientY);
        let pillEl: HTMLElement | null = null;
        for (const el of stack) {
          if (el instanceof HTMLElement && el.classList.contains('mindmap-topic')) {
            pillEl = el;
            break;
          }
        }
        if (!pillEl) return null;
        const targetId = pillEl.getAttribute('data-topic-id');
        if (!targetId || targetId === sourceId) return null;
        // Reject drops into the source's own subtree — would create a cycle.
        if (isDescendant(dragRoot, sourceId, targetId)) return null;

        const rect = pillEl.getBoundingClientRect();
        const relX = (clientX - rect.left) / Math.max(1, rect.width);
        const relY = (clientY - rect.top) / Math.max(1, rect.height);
        // Right third of the pill = "make me a child of this topic".
        // Top half / bottom half of the remaining area = sibling before / after.
        // Root can't accept sibling drops (no parent), but it can accept
        // child drops — collapse the whole pill to a child zone for root.
        if (targetId === dragRoot.id) {
          return { kind: 'child', parentId: targetId };
        }
        if (relX > 0.66) return { kind: 'child', parentId: targetId };
        if (relY < 0.5) return { kind: 'before', anchorId: targetId };
        return { kind: 'after', anchorId: targetId };
      };

      const onMove = (e: MouseEvent) => {
        if (!started) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) {
            return;
          }
          started = true;
          setReorder({ sourceId, target: null });
        }
        const target = hitTest(e.clientX, e.clientY);
        setReorder((s) => (s ? { ...s, target } : null));
      };

      const onUp = (e: MouseEvent) => {
        cleanup();
        if (!started) return;
        const target = hitTest(e.clientX, e.clientY);
        setReorder(null);
        if (!target) return;
        const next = moveTopic(dragRoot, sourceId, target);
        if (next) {
          applyRoot(next);
          // Keep focus on the moved topic so the user can keep navigating.
          setSelectedId(sourceId);
        }
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          cleanup();
          setReorder(null);
        }
      };

      // `function`-declared so onUp/onKey above can reference it without
      // tripping TS's "used before declaration" check on a const arrow.
      function cleanup() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('keydown', onKey);
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('keydown', onKey);
    },
    [applyRoot, root],
  );

  /* ---- Focus hand-off for freshly-created topics ---- */

  useLayoutEffect(() => {
    const pendingId = pendingFocusRef.current;
    if (!pendingId) return;
    if (findTopicPath(root, pendingId)) {
      setSelectedId(pendingId);
      setEditingId(pendingId);
      pendingFocusRef.current = null;
    }
  }, [root]);

  /* ---- Geometric neighbor navigation ---- */

  const moveSelection = useCallback(
    (from: string, dir: 'up' | 'down' | 'left' | 'right') => {
      const current = layout.topics.find((t) => t.id === from);
      if (!current) return;
      const cx = current.x + current.width / 2;
      const cy = current.y + current.height / 2;

      let best: LaidOutTopic | null = null;
      let bestScore = Infinity;
      for (const candidate of layout.topics) {
        if (candidate.id === from) continue;
        const dx = candidate.x + candidate.width / 2 - cx;
        const dy = candidate.y + candidate.height / 2 - cy;
        if (dir === 'left' && dx >= 0) continue;
        if (dir === 'right' && dx <= 0) continue;
        if (dir === 'up' && dy >= 0) continue;
        if (dir === 'down' && dy <= 0) continue;
        // Weight the movement axis heavier so "left" prefers candidates
        // that are clearly to the left rather than ones that happen to be
        // slightly diagonal.
        const primary = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
        const secondary =
          dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
        const score = primary + secondary * 2;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (best) setSelectedId(best.id);
    },
    [layout.topics],
  );

  /* ---- Render ---- */

  // We deliberately do NOT stop mousedown here. Topic pills below stop
  // their own mousedown events so clicking a topic never starts a drag,
  // but clicking the empty mindmap background should bubble up to the
  // canvas-node wrapper so the whole mindmap can be dragged around the
  // canvas — just like an image or shape node.
  return (
    <div
      className={`mindmap-node-body${isSelected ? ' mindmap-node-body--selected' : ''}`}
    >
      <div
        className="mindmap-viewport"
        style={{
          width: viewportWidth,
          height: viewportHeight,
          padding,
        }}
      >
        <div
          className="mindmap-content"
          style={{
            width: layout.width,
            height: layout.height,
          }}
        >
          <svg
            className="mindmap-branches"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`}
          >
            {layout.branches.map((b) => (
              <path
                key={b.id}
                d={b.path}
                fill="none"
                stroke={b.color}
                strokeWidth={2}
                strokeLinecap="round"
                opacity={0.85}
              />
            ))}
          </svg>
          {layout.topics.map((t) => (
            <TopicPill
              key={t.id}
              topic={t}
              isSelected={selectedId === t.id}
              isEditing={editingId === t.id}
              isDragSource={reorder?.sourceId === t.id}
              dropHint={
                reorder && reorder.target
                  ? reorder.target.kind === 'child' && reorder.target.parentId === t.id
                    ? 'child'
                    : reorder.target.kind === 'before' && reorder.target.anchorId === t.id
                      ? 'before'
                      : reorder.target.kind === 'after' && reorder.target.anchorId === t.id
                        ? 'after'
                        : null
                  : null
              }
              onBeginReorder={(e) => beginReorder(t.id, e)}
              onSelect={() => {
                setSelectedId(t.id);
                // Also mark the outer mindmap canvas node as selected so
                // canvas-level shortcuts (Delete, copy, etc.) act on the
                // right target.
                onSelectNode(node.id);
              }}
              onEnterEdit={() => {
                setSelectedId(t.id);
                setEditingId(t.id);
                onSelectNode(node.id);
              }}
              onCommitText={(text) => renameTopic(t.id, text)}
              onExitEdit={() => setEditingId(null)}
              onKeyAction={(action) => {
                switch (action.kind) {
                  case 'addChild':
                    addChild(t.id);
                    break;
                  case 'addSibling':
                    addSibling(t.id);
                    break;
                  case 'unindent':
                    unindentTopic(t.id);
                    break;
                  case 'delete':
                    removeTopic(t.id);
                    break;
                  case 'toggle':
                    toggle(t.id);
                    break;
                  case 'move':
                    moveSelection(t.id, action.dir);
                    break;
                  case 'exit':
                    setEditingId(null);
                    break;
                }
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

/* ---- Topic pill ---- */

type KeyAction =
  | { kind: 'addChild' }
  | { kind: 'addSibling' }
  | { kind: 'unindent' }
  | { kind: 'delete' }
  | { kind: 'toggle' }
  | { kind: 'exit' }
  | { kind: 'move'; dir: 'up' | 'down' | 'left' | 'right' };

interface TopicPillProps {
  topic: LaidOutTopic;
  isSelected: boolean;
  isEditing: boolean;
  /** True while THIS topic is being dragged in a reorder gesture. */
  isDragSource: boolean;
  /** When set, this topic is the current drop target — render the matching
   *  drop indicator (line above, line below, or "make child" outline). */
  dropHint: 'before' | 'after' | 'child' | null;
  /** Mousedown on the pill that should arm a reorder drag. The parent owns
   *  the threshold + window listeners; we just hand off the initial event. */
  onBeginReorder: (e: React.MouseEvent) => void;
  onSelect: () => void;
  onEnterEdit: () => void;
  onCommitText: (text: string) => void;
  onExitEdit: () => void;
  onKeyAction: (action: KeyAction) => void;
}

const TopicPill = ({
  topic,
  isSelected,
  isEditing,
  isDragSource,
  dropHint,
  onBeginReorder,
  onSelect,
  onEnterEdit,
  onCommitText,
  onExitEdit,
  onKeyAction,
}: TopicPillProps) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!isEditing) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // Drop the caret at the end of existing text instead of selecting
    // everything — for an empty topic this is a no-op, for an existing
    // one it lets the user append or edit without accidentally
    // overwriting with the next keystroke.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [isEditing]);

  // When the selected pill isn't editing, send keyboard focus to the
  // wrapper so arrow keys / Tab / Enter hit this component's handler
  // instead of the canvas keyboard hook.
  useEffect(() => {
    if (isEditing) return;
    if (isSelected) pillRef.current?.focus();
  }, [isSelected, isEditing]);

  // Push DOM text back in sync when the stored text changes from
  // elsewhere (undo, external update) and we're not mid-edit.
  useEffect(() => {
    if (isEditing) return;
    const el = editorRef.current;
    if (el && el.innerText !== topic.text) el.innerText = topic.text;
  }, [topic.text, isEditing]);

  const commit = useCallback(() => {
    const el = editorRef.current;
    const next = el ? el.innerText.replace(/\n+$/, '') : topic.text;
    if (next !== topic.text) onCommitText(next);
    onExitEdit();
  }, [onCommitText, onExitEdit, topic.text]);

  const cancel = useCallback(() => {
    const el = editorRef.current;
    if (el) el.innerText = topic.text;
    onExitEdit();
  }, [onExitEdit, topic.text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Stop React's synthetic event AND the underlying DOM event from
      // bubbling up to the window-level canvas keyboard listener. When
      // a topic is selected (not editing), the pill div is focused but
      // neither an <input> nor contentEditable, so `useCanvasKeyboard`'s
      // `!isEditable` check wouldn't otherwise filter out Delete /
      // Backspace / Tab / etc. — which would delete the entire mindmap
      // instead of the focused topic. We only consume keys we actually
      // handle below; everything else (Cmd+Z, Cmd+C, ...) falls through
      // untouched so canvas-level shortcuts keep working.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (isEditing) {
        if (e.key === 'Escape') {
          consume();
          cancel();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          consume();
          commit();
          onKeyAction({ kind: 'addSibling' });
          return;
        }
        if (e.key === 'Tab') {
          consume();
          commit();
          if (e.shiftKey) onKeyAction({ kind: 'unindent' });
          else onKeyAction({ kind: 'addChild' });
          return;
        }
        return;
      }

      // Selected, not editing.
      switch (e.key) {
        case 'Enter':
          consume();
          onKeyAction({ kind: 'addSibling' });
          return;
        case 'Tab':
          consume();
          if (e.shiftKey) onKeyAction({ kind: 'unindent' });
          else onKeyAction({ kind: 'addChild' });
          return;
        case 'Backspace':
        case 'Delete':
          consume();
          onKeyAction({ kind: 'delete' });
          return;
        case ' ':
          if (topic.hasChildren) {
            consume();
            onKeyAction({ kind: 'toggle' });
          }
          return;
        case 'ArrowUp':
          consume();
          onKeyAction({ kind: 'move', dir: 'up' });
          return;
        case 'ArrowDown':
          consume();
          onKeyAction({ kind: 'move', dir: 'down' });
          return;
        case 'ArrowLeft':
          consume();
          onKeyAction({ kind: 'move', dir: 'left' });
          return;
        case 'ArrowRight':
          consume();
          onKeyAction({ kind: 'move', dir: 'right' });
          return;
        case 'F2':
        case 'Escape':
          consume();
          if (e.key === 'F2') onEnterEdit();
          else onKeyAction({ kind: 'exit' });
          return;
        default:
          // A printable character should drop straight into edit mode
          // and replace the current text, mirroring Heptabase.
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            onEnterEdit();
            // Let the keydown commit into the contenteditable after
            // edit mode mounts by NOT preventing default.
          }
      }
    },
    [cancel, commit, isEditing, onEnterEdit, onKeyAction, topic.hasChildren],
  );

  const isRoot = topic.depth === 0;
  // Heptabase-style: the topic itself is chromeless. Color drives only
  // the selection cue and the collapse pill — the connecting branch
  // takes over as the primary color signal.
  const style: React.CSSProperties = {
    transform: `translate(${topic.x}px, ${topic.y}px)`,
    width: topic.width,
    minHeight: topic.height,
    color: isRoot ? '#1f2328' : '#1f2328',
    // Selected-state underline uses currentColor, so pipe the branch
    // color through when selected — otherwise keep text neutral.
    ['--mindmap-topic-accent' as string]: topic.color,
  };

  const isEmpty = !topic.text;

  return (
    <div
      ref={pillRef}
      data-topic-id={topic.id}
      className={[
        'mindmap-topic',
        isRoot && 'mindmap-topic--root',
        isSelected && 'mindmap-topic--selected',
        isEditing && 'mindmap-topic--editing',
        topic.collapsed && 'mindmap-topic--collapsed',
        isDragSource && 'mindmap-topic--drag-source',
        dropHint === 'before' && 'mindmap-topic--drop-before',
        dropHint === 'after' && 'mindmap-topic--drop-after',
        dropHint === 'child' && 'mindmap-topic--drop-child',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      tabIndex={0}
      onMouseDown={(e) => {
        // Pan-trigger gestures must reach the outer .canvas-container so
        // the user can grab the canvas even when the cursor happens to
        // land on a topic. We let middle-button, alt+left, and hand-tool
        // mode bubble; everything else is a topic-interaction gesture, so
        // we stop propagation to keep the outer mindmap card from also
        // starting a node drag.
        const handToolActive =
          e.currentTarget.closest('.canvas-container--hand') != null;
        const isPanGesture =
          e.button === 1 ||
          (e.button === 0 && (e.altKey || handToolActive));
        if (isPanGesture) return;
        e.stopPropagation();
        onSelect();
        // Don't arm a reorder drag while editing — the user is interacting
        // with text inside contentEditable, not with the pill as a whole.
        if (e.button === 0 && !isEditing) onBeginReorder(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEnterEdit();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={editorRef}
        className={[
          'mindmap-topic-text',
          isEmpty && !isEditing && 'mindmap-topic-text--empty',
        ]
          .filter(Boolean)
          .join(' ')}
        contentEditable={isEditing}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Untitled"
        onBlur={() => {
          if (isEditing) commit();
        }}
      >
        {topic.text}
      </div>
      {/* Collapsed-subtree hint: a small filled dot in the branch color
          sitting just after the text, so users can see "something is
          hidden here" without the heavy +/- button. */}
      {topic.collapsed && topic.hasChildren && (
        <span
          className="mindmap-topic-collapsed-dot"
          style={{ background: topic.color }}
          aria-label="collapsed"
        />
      )}
    </div>
  );
};

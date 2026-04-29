import type { MindmapTopic } from '../types';

/**
 * Horizontal tree layout for a Heptabase-style mindmap.
 *
 * The root sits vertically centered. Children grow rightward, each at a
 * fixed horizontal step from its parent. Vertical space is allocated
 * bottom-up: each topic reserves a slot equal to `max(slotHeight,
 * sum(children slots))`, so subtrees never overlap regardless of depth.
 * This is a simplified Reingold–Tilford: good enough for Heptabase-like
 * cards (a few dozen topics) and stable as the user edits.
 *
 * The returned `width`/`height` describe the bounding box of every
 * rendered topic; callers pad by `PADDING` on every side.
 *
 * Collapsed topics still render themselves but skip their descendants.
 */

export interface LaidOutTopic {
  id: string;
  /** Parent topic id, or null for the root. Used to hit-test keyboard
   *  navigation (Shift+Tab, ArrowLeft). */
  parentId: string | null;
  /** Depth from root — 0 for the root, 1 for a primary branch, etc. */
  depth: number;
  /** Top-left corner of the topic box in mindmap-local coords. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** Resolved color — branch-colored for non-root topics, neutral for
   *  the root. Drives both the topic pill border and the in-bound
   *  branch line. */
  color: string;
  collapsed: boolean;
  hasChildren: boolean;
}

export interface LaidOutBranch {
  /** Parent → child connection. Bezier path in mindmap-local coords,
   *  ready to drop into an <svg> <path d={...}> */
  id: string;
  parentId: string;
  childId: string;
  path: string;
  color: string;
}

export interface MindmapLayout {
  topics: LaidOutTopic[];
  branches: LaidOutBranch[];
  /** Bounding box of the laid-out content (excluding outer padding). */
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Gap between a parent and its children on the horizontal axis. */
  hGap?: number;
  /** Minimum gap between sibling topic rows. */
  vGap?: number;
  /** Logical topic box width (used for all topics). */
  topicWidth?: number;
  /** Logical topic box height (used when a topic's rendered height is
   *  unknown). In v1 every topic is a single-line pill. */
  topicHeight?: number;
}

const DEFAULT_OPTS: Required<LayoutOptions> = {
  hGap: 64,
  vGap: 14,
  topicWidth: 180,
  topicHeight: 34,
};

/**
 * Heptabase-ish palette for the first six primary branches. Indexing
 * beyond the end wraps, which is fine for the rare case of >6 branches
 * — the colors just repeat. Tuned to match Heptabase's default theme:
 * warm yellow, cool gray, warm orange, etc.
 */
const BRANCH_COLORS = [
  '#D9A13B', // yellow
  '#9AA0A6', // gray
  '#E07B4A', // orange
  '#3B8FD6', // blue
  '#7A57C4', // purple
  '#2F8F5A', // green
];

const ROOT_COLOR = '#1F2328';

/**
 * Estimate the rendered pixel width of a topic's text without touching
 * the DOM. We intentionally keep this cheap rather than doing a hidden
 * measure pass — the approximation is accurate enough for layout and
 * stays synchronous, which matters because `layoutMindmap` runs in a
 * `useMemo` on every tree mutation.
 *
 * Real CJK glyphs in the system UI fallback fonts (PingFang / Noto Sans
 * CJK) render at ~1.0em — a touch wider once you account for inter-glyph
 * advance. The earlier 0.98 multiplier was tuned for a hypothetical
 * monospace-leaning font and consistently undersized Chinese topics by a
 * few px, which combined with `overflow-wrap: anywhere` to drop the last
 * character onto a new line. Bias the estimate slightly above 1.0 so the
 * slot is never narrower than the rendered text.
 */
const CJK_RANGE = /[　-鿿＀-￯぀-ヿ]/;
const estimateTextWidth = (text: string, fontSize: number): number => {
  if (!text) return 0;
  const hasCJK = CJK_RANGE.test(text);
  const avg = hasCJK ? fontSize * 1.05 : fontSize * 0.65;
  return text.length * avg;
};

const ROOT_MIN_WIDTH = 120;
const TOPIC_MIN_WIDTH = 90;
const TOPIC_MAX_WIDTH = 320;
// Horizontal chrome around the text: `.mindmap-topic` has `padding: 0 8px`
// (16px) and the inner `.mindmap-topic-text` adds `padding: 1px 3px` (6px),
// for 22px total. Keep a small safety buffer for sub-pixel rounding.
const TOPIC_HORIZONTAL_PADDING = 24;
// Width reserved for the collapsed-state dot rendered next to the text:
// `.mindmap-topic-collapsed-dot` is 6px wide + 6px margin-left.
const COLLAPSED_DOT_RESERVE = 12;

export const layoutMindmap = (
  root: MindmapTopic,
  opts: LayoutOptions = {},
): MindmapLayout => {
  const o = { ...DEFAULT_OPTS, ...opts };
  const topics: LaidOutTopic[] = [];
  const branches: LaidOutBranch[] = [];

  // Per-topic widths. The root gets a larger font + generous minimum so
  // short "Central topic"-style labels don't awkwardly wrap at word
  // boundaries; every other topic scales between TOPIC_MIN_WIDTH and
  // TOPIC_MAX_WIDTH based on its text length.
  const widthOf = new Map<string, number>();
  const resolveWidth = (t: MindmapTopic, isRoot: boolean): number => {
    const cached = widthOf.get(t.id);
    if (cached !== undefined) return cached;
    const fontSize = isRoot ? 20 : 14;
    const text = t.text || 'Untitled';
    // Collapsed non-root topics render a dot next to the text inside the
    // same flex row; reserve space for it so the text doesn't get squeezed.
    const collapsedReserve =
      !isRoot && t.collapsed && t.children.length > 0 ? COLLAPSED_DOT_RESERVE : 0;
    const estimated =
      estimateTextWidth(text, fontSize) + TOPIC_HORIZONTAL_PADDING + collapsedReserve;
    const min = isRoot ? ROOT_MIN_WIDTH : TOPIC_MIN_WIDTH;
    const w = Math.max(min, Math.min(TOPIC_MAX_WIDTH, Math.ceil(estimated)));
    widthOf.set(t.id, w);
    return w;
  };

  // Per-topic rendered height. When a topic's text exceeds TOPIC_MAX_WIDTH
  // it wraps to multiple lines; the slot allocated for it must grow to
  // match, otherwise sibling subtrees stack on top of the wrapped text
  // (which is what produced the "long topic overlaps the next branch"
  // bug). Root is forced single-line by CSS (`white-space: nowrap`), so
  // we keep the default height there.
  const heightOf = new Map<string, number>();
  const resolveHeight = (t: MindmapTopic, isRoot: boolean): number => {
    const cached = heightOf.get(t.id);
    if (cached !== undefined) return cached;
    if (isRoot) {
      heightOf.set(t.id, o.topicHeight);
      return o.topicHeight;
    }
    const fontSize = 14;
    const lineHeight = Math.ceil(fontSize * 1.3); // matches .mindmap-topic CSS
    const w = resolveWidth(t, false);
    const collapsedReserve =
      t.collapsed && t.children.length > 0 ? COLLAPSED_DOT_RESERVE : 0;
    const available = Math.max(
      lineHeight,
      w - TOPIC_HORIZONTAL_PADDING - collapsedReserve,
    );
    const text = t.text || 'Untitled';
    const textWidth = estimateTextWidth(text, fontSize);
    const lines = Math.max(1, Math.ceil(textWidth / available));
    // 4px = .mindmap-topic-text top+bottom padding (1px) + a hair of buffer
    // for line-box rounding. Clamp to the default topic slot so single-line
    // topics keep their existing visual rhythm.
    const h = Math.max(o.topicHeight, lines * lineHeight + 4);
    heightOf.set(t.id, h);
    return h;
  };

  // Pass 1: compute the vertical "slot" each topic needs — the height
  // it will occupy including all visible descendants.
  const slotOf = new Map<string, number>();
  const measure = (t: MindmapTopic, depth: number): number => {
    const isRoot = depth === 0;
    const own = resolveHeight(t, isRoot);
    const kids = t.collapsed ? [] : t.children;
    if (kids.length === 0) {
      slotOf.set(t.id, own);
      return own;
    }
    let total = 0;
    for (let i = 0; i < kids.length; i++) {
      total += measure(kids[i], depth + 1);
      if (i > 0) total += o.vGap;
    }
    // A parent with children still needs at least its own height so the
    // pill doesn't collapse into a sliver when a single child lives below.
    const s = Math.max(total, own);
    slotOf.set(t.id, s);
    return s;
  };
  const totalHeight = measure(root, 0);

  // Pass 2: place each topic. `yCursor` is the top of the current node's
  // slot; we center the node vertically inside its slot, then walk
  // children top-down.
  const walk = (
    t: MindmapTopic,
    depth: number,
    parentId: string | null,
    xLeft: number,
    yCursor: number,
    color: string,
  ) => {
    const isRoot = depth === 0;
    const selfWidth = resolveWidth(t, isRoot);
    const selfHeight = resolveHeight(t, isRoot);
    const slot = slotOf.get(t.id) ?? selfHeight;
    const y = yCursor + (slot - selfHeight) / 2;
    const laidOut: LaidOutTopic = {
      id: t.id,
      parentId,
      depth,
      x: xLeft,
      y,
      width: selfWidth,
      height: selfHeight,
      text: t.text,
      color,
      collapsed: !!t.collapsed,
      hasChildren: t.children.length > 0,
    };
    topics.push(laidOut);

    if (t.collapsed || t.children.length === 0) return;

    // Children sit to the right of this topic, stacked vertically
    // within this topic's slot.
    const childXLeft = xLeft + selfWidth + o.hGap;
    let childYCursor = yCursor;
    for (let i = 0; i < t.children.length; i++) {
      const child = t.children[i];
      const childHeight = resolveHeight(child, false);
      const childSlot = slotOf.get(child.id) ?? childHeight;

      // Primary branches get a color from the palette; deeper topics
      // inherit their branch ancestor's color.
      const childColor =
        depth === 0 ? BRANCH_COLORS[i % BRANCH_COLORS.length] : color;

      walk(child, depth + 1, t.id, childXLeft, childYCursor, childColor);

      // Branches anchor at the vertical CENTER of both parent and
      // child so the curve reads as "line passes through the middle
      // of the text". Anchoring at the baseline puts text visually
      // above its branch, which felt off-axis for this chromeless
      // layout where there's no outline to give the baseline a
      // reason to exist.
      const parentRightX = xLeft + selfWidth;
      const parentAnchorY = y + selfHeight / 2;
      const childLeftX = childXLeft;
      const childAnchorY =
        childYCursor + (childSlot - childHeight) / 2 + childHeight / 2;
      const midX = parentRightX + (childLeftX - parentRightX) / 2;
      const path =
        `M ${parentRightX} ${parentAnchorY} ` +
        `C ${midX} ${parentAnchorY}, ${midX} ${childAnchorY}, ${childLeftX} ${childAnchorY}`;
      branches.push({
        id: `${t.id}->${child.id}`,
        parentId: t.id,
        childId: child.id,
        path,
        color: childColor,
      });

      childYCursor += childSlot + o.vGap;
    }
  };

  walk(root, 0, null, 0, 0, ROOT_COLOR);

  // Normalize to a non-negative bounding box so the renderer can
  // translate directly by (topic.x, topic.y).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of topics) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x + t.width > maxX) maxX = t.x + t.width;
    if (t.y + t.height > maxY) maxY = t.y + t.height;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = o.topicWidth;
    maxY = o.topicHeight;
  }

  // Shift so the whole tree starts at (0, 0). Update branch paths by
  // re-running the same shift on their coordinates.
  if (minX !== 0 || minY !== 0) {
    for (const t of topics) {
      t.x -= minX;
      t.y -= minY;
    }
    for (const b of branches) {
      b.path = shiftPath(b.path, -minX, -minY);
    }
  }

  return {
    topics,
    branches,
    width: maxX - minX,
    height: Math.max(maxY - minY, totalHeight),
  };
};

/**
 * Shift every coordinate in an SVG path command string by (dx, dy).
 * Only used for the M and C commands emitted above, so we can lean on
 * a simple number-token rewrite.
 */
const shiftPath = (path: string, dx: number, dy: number): string => {
  const tokens = path.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  let numberIndex = 0;
  for (const tok of tokens) {
    if (tok === 'M' || tok === 'C' || tok === 'L') {
      out.push(tok);
      numberIndex = 0;
      continue;
    }
    const cleaned = tok.replace(/,$/, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) {
      const shifted = numberIndex % 2 === 0 ? n + dx : n + dy;
      out.push(tok.endsWith(',') ? `${shifted},` : `${shifted}`);
      numberIndex++;
    } else {
      out.push(tok);
    }
  }
  return out.join(' ');
};

/* ---- Tree mutation helpers ---- */

/**
 * Find a topic by id and return a path from root → topic. Returns null
 * when the id is not present. The path is used by every mutation below
 * so the caller doesn't have to re-traverse.
 */
export const findTopicPath = (
  root: MindmapTopic,
  id: string,
): MindmapTopic[] | null => {
  if (root.id === id) return [root];
  for (const child of root.children) {
    const sub = findTopicPath(child, id);
    if (sub) return [root, ...sub];
  }
  return null;
};

/**
 * Return a new tree produced by applying `fn` to every topic. `fn` may
 * return a new topic (replacing the input) or `null` to delete. The
 * root is never allowed to be deleted — callers that need that case
 * should handle it outside this helper.
 */
export const mapTopics = (
  root: MindmapTopic,
  fn: (t: MindmapTopic, parent: MindmapTopic | null) => MindmapTopic | null,
): MindmapTopic => {
  const walk = (t: MindmapTopic, parent: MindmapTopic | null): MindmapTopic => {
    const mapped = fn(t, parent) ?? t;
    return {
      ...mapped,
      children: mapped.children
        .map((c) => {
          const result = fn(c, mapped);
          if (result === null) return null;
          // Recurse into the returned (possibly-rewritten) child.
          return walk(result ?? c, mapped);
        })
        .filter((c): c is MindmapTopic => c !== null),
    };
  };
  return walk(root, null);
};

/** Insert a child topic under `parentId`. If `afterId` is provided, the
 *  child lands directly after that sibling; otherwise it appends. */
export const insertChild = (
  root: MindmapTopic,
  parentId: string,
  child: MindmapTopic,
  afterId?: string,
): MindmapTopic => {
  const walk = (t: MindmapTopic): MindmapTopic => {
    if (t.id === parentId) {
      const children = [...t.children];
      if (afterId) {
        const idx = children.findIndex((c) => c.id === afterId);
        if (idx >= 0) {
          children.splice(idx + 1, 0, child);
          return { ...t, children };
        }
      }
      children.push(child);
      // Inserting children implicitly expands the parent.
      return { ...t, children, collapsed: false };
    }
    return { ...t, children: t.children.map(walk) };
  };
  return walk(root);
};

/** Replace a topic's text. Returns the root unchanged if no match. */
export const setTopicText = (
  root: MindmapTopic,
  id: string,
  text: string,
): MindmapTopic => {
  const walk = (t: MindmapTopic): MindmapTopic => {
    if (t.id === id) return { ...t, text };
    return { ...t, children: t.children.map(walk) };
  };
  return walk(root);
};

/** Toggle collapsed on a topic. The root can't be collapsed. */
export const toggleCollapsed = (
  root: MindmapTopic,
  id: string,
): MindmapTopic => {
  if (root.id === id) return root;
  const walk = (t: MindmapTopic): MindmapTopic => {
    if (t.id === id) return { ...t, collapsed: !t.collapsed };
    return { ...t, children: t.children.map(walk) };
  };
  return walk(root);
};

/**
 * Delete a non-root topic. Returns `{ root, nextFocusId }` where
 * `nextFocusId` points at the sibling above (or the parent if the
 * victim was a first child) so the caller can keep focus reasonable.
 */
export const deleteTopic = (
  root: MindmapTopic,
  id: string,
): { root: MindmapTopic; nextFocusId: string } | null => {
  if (root.id === id) return null;
  let nextFocusId = root.id;
  const walk = (t: MindmapTopic): MindmapTopic => {
    const idx = t.children.findIndex((c) => c.id === id);
    if (idx >= 0) {
      const next = [...t.children];
      next.splice(idx, 1);
      if (next.length > 0) {
        nextFocusId = next[Math.max(0, idx - 1)].id;
      } else {
        nextFocusId = t.id;
      }
      return { ...t, children: next };
    }
    return { ...t, children: t.children.map(walk) };
  };
  const nextRoot = walk(root);
  return { root: nextRoot, nextFocusId };
};

/** Return the parent topic for a given id, or null for the root/missing. */
export const findParent = (
  root: MindmapTopic,
  id: string,
): MindmapTopic | null => {
  if (root.id === id) return null;
  const walk = (t: MindmapTopic): MindmapTopic | null => {
    for (const c of t.children) {
      if (c.id === id) return t;
      const deeper = walk(c);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(root);
};

/** True if `descendantId` lives anywhere in the subtree rooted at
 *  `ancestorId`. Used to reject drag-reorders that would create a cycle
 *  (dropping a topic into one of its own descendants). */
export const isDescendant = (
  root: MindmapTopic,
  ancestorId: string,
  descendantId: string,
): boolean => {
  if (ancestorId === descendantId) return false;
  const findAncestor = (t: MindmapTopic): MindmapTopic | null => {
    if (t.id === ancestorId) return t;
    for (const c of t.children) {
      const hit = findAncestor(c);
      if (hit) return hit;
    }
    return null;
  };
  const subtree = findAncestor(root);
  if (!subtree) return false;
  const walk = (t: MindmapTopic): boolean => {
    if (t.id === descendantId) return true;
    return t.children.some(walk);
  };
  return subtree.children.some(walk);
};

/**
 * Drop target for a drag-reorder. `before` / `after` insert as a sibling
 * of `anchorId`; `child` appends as the last child of `parentId`.
 */
export type DropTarget =
  | { kind: 'before'; anchorId: string }
  | { kind: 'after'; anchorId: string }
  | { kind: 'child'; parentId: string };

/**
 * Move `sourceId` to `target`. Returns the new root, or `null` when the
 * move is invalid (source is the root, target lives in source's subtree,
 * or anchor/parent isn't found). Implementation: locate the source
 * subtree, splice it out of its current parent, then insert it at the
 * target. Handles the same-parent reorder case (where removing the
 * source shifts the anchor's index) by computing the insertion index
 * after the removal.
 */
export const moveTopic = (
  root: MindmapTopic,
  sourceId: string,
  target: DropTarget,
): MindmapTopic | null => {
  if (sourceId === root.id) return null;
  // No-op moves: dropping a topic onto itself or onto its current parent
  // when the position wouldn't change.
  if (target.kind !== 'child' && target.anchorId === sourceId) return null;
  if (target.kind === 'child' && target.parentId === sourceId) return null;
  if (isDescendant(root, sourceId, target.kind === 'child' ? target.parentId : target.anchorId)) {
    return null;
  }

  // Lift the source subtree out of the tree.
  const sourcePath = findTopicPath(root, sourceId);
  if (!sourcePath) return null;
  const sourceTopic = sourcePath[sourcePath.length - 1];
  const removed = deleteTopic(root, sourceId);
  if (!removed) return null;
  let next = removed.root;

  if (target.kind === 'child') {
    next = insertChild(next, target.parentId, sourceTopic);
    return next;
  }

  // Sibling drop: locate the anchor's parent in the post-removal tree.
  const anchorParent = findParent(next, target.anchorId);
  if (!anchorParent) return null;
  const idx = anchorParent.children.findIndex((c) => c.id === target.anchorId);
  if (idx < 0) return null;
  const insertAfterId =
    target.kind === 'after'
      ? target.anchorId
      : idx > 0
        ? anchorParent.children[idx - 1].id
        : undefined;
  // `insertChild` with no afterId appends — we want to prepend when
  // dropping `before` the first child. Handle that explicitly.
  if (target.kind === 'before' && idx === 0) {
    const walk = (t: MindmapTopic): MindmapTopic => {
      if (t.id === anchorParent.id) {
        return { ...t, children: [sourceTopic, ...t.children], collapsed: false };
      }
      return { ...t, children: t.children.map(walk) };
    };
    return walk(next);
  }
  return insertChild(next, anchorParent.id, sourceTopic, insertAfterId);
};

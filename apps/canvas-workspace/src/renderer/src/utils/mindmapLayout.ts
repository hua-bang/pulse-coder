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
 * The canvas app ships a monospace-leaning UI font, so Latin chars at
 * the topic font sizes (14 / 20px) run ~0.6em wide; CJK chars are
 * ~0.95em. We pick a slightly pessimistic multiplier so the estimated
 * slot never ends up narrower than the rendered text — if it did, the
 * text would either wrap (for pre-wrap) or overshoot its slot and clip
 * into the neighbouring branch.
 */
const CJK_RANGE = /[　-鿿＀-￯぀-ヿ]/;
const estimateTextWidth = (text: string, fontSize: number): number => {
  if (!text) return 0;
  const hasCJK = CJK_RANGE.test(text);
  const avg = hasCJK ? fontSize * 0.98 : fontSize * 0.65;
  return text.length * avg;
};

const ROOT_MIN_WIDTH = 120;
const TOPIC_MIN_WIDTH = 90;
const TOPIC_MAX_WIDTH = 260;
const TOPIC_HORIZONTAL_PADDING = 18;

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
    const estimated = estimateTextWidth(text, fontSize) + TOPIC_HORIZONTAL_PADDING;
    const min = isRoot ? ROOT_MIN_WIDTH : TOPIC_MIN_WIDTH;
    const w = Math.max(min, Math.min(TOPIC_MAX_WIDTH, Math.ceil(estimated)));
    widthOf.set(t.id, w);
    return w;
  };

  // Pass 1: compute the vertical "slot" each topic needs — the height
  // it will occupy including all visible descendants.
  const slotOf = new Map<string, number>();
  const measure = (t: MindmapTopic): number => {
    const kids = t.collapsed ? [] : t.children;
    if (kids.length === 0) {
      const s = o.topicHeight;
      slotOf.set(t.id, s);
      return s;
    }
    let total = 0;
    for (let i = 0; i < kids.length; i++) {
      total += measure(kids[i]);
      if (i > 0) total += o.vGap;
    }
    // A parent with children still needs at least its own height so the
    // pill doesn't collapse into a sliver when a single child lives below.
    const s = Math.max(total, o.topicHeight);
    slotOf.set(t.id, s);
    return s;
  };
  const totalHeight = measure(root);

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
    const slot = slotOf.get(t.id) ?? o.topicHeight;
    const y = yCursor + (slot - o.topicHeight) / 2;
    const laidOut: LaidOutTopic = {
      id: t.id,
      parentId,
      depth,
      x: xLeft,
      y,
      width: selfWidth,
      height: o.topicHeight,
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
      const childSlot = slotOf.get(child.id) ?? o.topicHeight;
      const childWidth = resolveWidth(child, false);

      // Primary branches get a color from the palette; deeper topics
      // inherit their branch ancestor's color.
      const childColor =
        depth === 0 ? BRANCH_COLORS[i % BRANCH_COLORS.length] : color;

      walk(child, depth + 1, t.id, childXLeft, childYCursor, childColor);

      // Heptabase anchors: branches enter the child at its text baseline
      // (bottom of the topic box), which visually sits just under the
      // text. The root is special — it has no underline, so branches
      // leave it at its vertical center. Every other parent branches off
      // of its own baseline, so incoming + outgoing lines share the
      // same horizontal track and read as a continuous "underline".
      const parentRightX = xLeft + selfWidth;
      const parentAnchorY =
        depth === 0 ? y + o.topicHeight / 2 : y + o.topicHeight;
      const childLeftX = childXLeft;
      const childAnchorY =
        childYCursor +
        (childSlot - o.topicHeight) / 2 +
        o.topicHeight;
      const midX = parentRightX + (childLeftX - parentRightX) / 2;
      // When the child itself has visible children, extend the incoming
      // branch horizontally across the child's full width so the line
      // reads as an "underline" that outgoing branches share with the
      // incoming one. Leaves get no extension — their text sits at the
      // end of the curve, matching Heptabase's look.
      const childHasVisibleChildren =
        child.children.length > 0 && !child.collapsed;
      const childRightX = childXLeft + childWidth;
      const tail = childHasVisibleChildren
        ? ` L ${childRightX} ${childAnchorY}`
        : '';
      const path =
        `M ${parentRightX} ${parentAnchorY} ` +
        `C ${midX} ${parentAnchorY}, ${midX} ${childAnchorY}, ${childLeftX} ${childAnchorY}` +
        tail;
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

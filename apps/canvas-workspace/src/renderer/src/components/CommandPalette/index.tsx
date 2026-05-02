import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import type { CanvasNode, FileNodeData, TextNodeData } from '../../types';

/**
 * A single executable entry in the palette. Commands are bound by the
 * caller (Canvas/index.tsx) — the palette only routes selection back
 * to `command.run()` and dismisses itself.
 */
export interface PaletteCommand {
  id: string;
  /** Primary label — also the main field matched against the query. */
  title: string;
  /** Secondary line shown beneath the title. */
  hint?: string;
  /** Used both for visual section grouping and result ordering. */
  group: 'create' | 'navigate' | 'view' | 'edit' | 'help';
  /** Lowercased extra strings the fuzzy matcher will consider. */
  aliases?: string[];
  /** Optional shortcut string displayed on the right (e.g. "Cmd+D"). */
  shortcut?: string;
  /** When provided and false, the command is filtered out — used for
   *  selection-dependent commands ("Duplicate selection"). */
  enabled?: boolean;
  run: () => void;
}

const GROUP_ORDER: Array<PaletteCommand['group']> = ['edit', 'create', 'navigate', 'view', 'help'];

const GROUP_LABEL: Record<PaletteCommand['group'], string> = {
  create: 'Create',
  navigate: 'Navigate',
  view: 'View',
  edit: 'Edit',
  help: 'Help',
};

interface NodeResult {
  kind: 'node';
  node: CanvasNode;
  matchType: 'title-prefix' | 'title-contains' | 'filename' | 'content' | 'recent';
  matchText: string;
}

interface CommandResult {
  kind: 'command';
  command: PaletteCommand;
}

type PaletteItem = NodeResult | CommandResult;

interface Section {
  label: string;
  items: PaletteItem[];
}

interface Props {
  nodes: CanvasNode[];
  commands: PaletteCommand[];
  onSelectNode: (node: CanvasNode) => void;
  onClose: () => void;
}

const MAX_NODE_RESULTS = 20;

/**
 * Cmd+K palette — unified search-and-command surface for the canvas.
 *
 * Two kinds of items mix in one keyboard-navigated list:
 *   - **Nodes**: the existing search behavior (title / filename /
 *     content), so the user can jump to anything that's already on the
 *     canvas.
 *   - **Commands**: caller-supplied actions (create node, fit all,
 *     toggle chat, …). They don't need to be on the canvas to be
 *     reachable.
 *
 * The split is intentional: when you type "agent" and there's already
 * an agent node, you usually want to jump to it, but if you don't we
 * still surface "Create agent" so the panel is always actionable.
 */
export const CommandPalette = ({ nodes, commands, onSelectNode, onClose }: Props) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const enabledCommands = useMemo(
    () => commands.filter((c) => c.enabled !== false),
    [commands],
  );

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();

    if (!q) {
      // Empty query: show every command grouped by category, plus the
      // most-recently-edited nodes underneath. The "default state"
      // doubles as a discoverability surface — users who open the
      // palette without typing learn the command set just by looking.
      const out: Section[] = [];
      for (const group of GROUP_ORDER) {
        const items = enabledCommands
          .filter((c) => c.group === group)
          .map((c): CommandResult => ({ kind: 'command', command: c }));
        if (items.length > 0) out.push({ label: GROUP_LABEL[group], items });
      }
      const recentNodes = [...nodes]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 8)
        .map((node): NodeResult => ({
          kind: 'node',
          node,
          matchType: 'recent',
          matchText: node.title,
        }));
      if (recentNodes.length > 0) out.push({ label: 'Recent nodes', items: recentNodes });
      return out;
    }

    const nodeResults: NodeResult[] = [];
    for (const node of nodes) {
      const titleLower = node.title.toLowerCase();
      if (titleLower.startsWith(q)) {
        nodeResults.push({ kind: 'node', node, matchType: 'title-prefix', matchText: node.title });
        continue;
      }
      if (titleLower.includes(q)) {
        nodeResults.push({ kind: 'node', node, matchType: 'title-contains', matchText: node.title });
        continue;
      }
      if (node.type === 'file') {
        const fileData = node.data as FileNodeData;
        const filePath = fileData.filePath || '';
        const fileName = filePath.split('/').pop() || '';
        if (fileName.toLowerCase().includes(q) || filePath.toLowerCase().includes(q)) {
          nodeResults.push({ kind: 'node', node, matchType: 'filename', matchText: filePath });
          continue;
        }
        const content = fileData.content || '';
        if (content.toLowerCase().includes(q)) {
          const idx = content.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 20);
          const end = Math.min(content.length, idx + q.length + 20);
          const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
          nodeResults.push({ kind: 'node', node, matchType: 'content', matchText: snippet });
          continue;
        }
      } else if (node.type === 'text') {
        const content = (node.data as TextNodeData).content || '';
        if (content.toLowerCase().includes(q)) {
          const idx = content.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 20);
          const end = Math.min(content.length, idx + q.length + 20);
          const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
          nodeResults.push({ kind: 'node', node, matchType: 'content', matchText: snippet });
          continue;
        }
      }
    }
    const nodePriority: Record<NodeResult['matchType'], number> = {
      'title-prefix': 0,
      'title-contains': 1,
      filename: 2,
      content: 3,
      recent: 4,
    };
    nodeResults.sort((a, b) => {
      const pa = nodePriority[a.matchType];
      const pb = nodePriority[b.matchType];
      if (pa !== pb) return pa - pb;
      return a.node.title.localeCompare(b.node.title);
    });

    const commandHits = enabledCommands.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      if (c.aliases?.some((alias) => alias.toLowerCase().includes(q))) return true;
      return false;
    });

    const out: Section[] = [];
    if (nodeResults.length > 0) {
      out.push({ label: 'Nodes', items: nodeResults.slice(0, MAX_NODE_RESULTS) });
    }
    if (commandHits.length > 0) {
      out.push({
        label: 'Commands',
        items: commandHits.map((c): CommandResult => ({ kind: 'command', command: c })),
      });
    }
    return out;
  }, [query, nodes, enabledCommands]);

  // Flat list of items in display order — what arrow-key navigation
  // walks. Section headers don't get a slot; selectedIndex points
  // straight at items.
  const flatItems = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;
    const selected = container.querySelector(`[data-palette-index="${selectedIndex}"]`) as HTMLElement | null;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const runItem = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'node') {
        onSelectNode(item.node);
      } else {
        item.command.run();
      }
      onClose();
    },
    [onSelectNode, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter' && flatItems[selectedIndex]) {
        runItem(flatItems[selectedIndex]);
        return;
      }
    },
    [flatItems, selectedIndex, runItem, onClose],
  );

  let runningIndex = 0;

  return (
    <div className="command-palette-overlay" onClick={onClose} onWheel={(e) => e.stopPropagation()}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input-wrapper">
          <svg className="command-palette-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Search nodes or run a command..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="command-palette-results" ref={resultsRef}>
          {flatItems.length === 0 ? (
            <div className="command-palette-empty">No matches</div>
          ) : (
            sections.map((section) => (
              <div key={section.label} className="command-palette-section">
                <div className="command-palette-section-label">{section.label}</div>
                {section.items.map((item) => {
                  const idx = runningIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <PaletteRow
                      key={item.kind === 'node' ? `node:${item.node.id}` : `cmd:${item.command.id}`}
                      item={item}
                      index={idx}
                      isSelected={isSelected}
                      onActivate={runItem}
                      onHover={setSelectedIndex}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-hint">
          <span>↑↓ Navigate</span>
          <span>↵ Run</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
};

interface RowProps {
  item: PaletteItem;
  index: number;
  isSelected: boolean;
  onActivate: (item: PaletteItem) => void;
  onHover: (index: number) => void;
}

const PaletteRow = ({ item, index, isSelected, onActivate, onHover }: RowProps) => {
  const className = `command-palette-row ${isSelected ? 'selected' : ''}`;
  if (item.kind === 'node') {
    const showSnippet = item.matchType !== 'title-prefix' && item.matchType !== 'title-contains' && item.matchType !== 'recent';
    return (
      <div
        className={className}
        data-palette-index={index}
        onClick={() => onActivate(item)}
        onMouseEnter={() => onHover(index)}
      >
        <div className="command-palette-row-main">
          <span className={`command-palette-badge command-palette-badge--${item.node.type}`}>
            {item.node.type}
          </span>
          <span className="command-palette-row-title">{item.node.title}</span>
        </div>
        {showSnippet && <div className="command-palette-row-hint">{item.matchText}</div>}
      </div>
    );
  }
  const c = item.command;
  return (
    <div
      className={className}
      data-palette-index={index}
      onClick={() => onActivate(item)}
      onMouseEnter={() => onHover(index)}
    >
      <div className="command-palette-row-main">
        <span className="command-palette-badge command-palette-badge--cmd">{c.group}</span>
        <span className="command-palette-row-title">{c.title}</span>
        {c.shortcut && <span className="command-palette-shortcut">{c.shortcut}</span>}
      </div>
      {c.hint && <div className="command-palette-row-hint">{c.hint}</div>}
    </div>
  );
};

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import type { CanvasNode } from '../../types';
import { CanvasNodeView } from '../CanvasNodeView';
import { IframeNodeBody } from '../IframeNodeBody';
import { getNodeDisplayLabel } from '../../utils/nodeLabel';
import { copyTextToClipboard } from '../../utils/clipboard';

const DEFAULT_REFERENCE_DRAWER_WIDTH = 420;
const MIN_REFERENCE_DRAWER_WIDTH = 260;
const MAX_REFERENCE_DRAWER_WIDTH = 1000;
const REFERENCE_SEARCH_DEBOUNCE_MS = 180;

const NODE_TYPE_LABELS: Record<CanvasNode['type'], string> = {
  agent: 'Agent',
  file: 'File',
  frame: 'Frame',
  group: 'Group',
  iframe: 'Web',
  image: 'Image',
  mindmap: 'Mindmap',
  shape: 'Shape',
  terminal: 'Terminal',
  text: 'Text',
};

interface NodeReferenceEntry {
  kind?: 'node';
  nodeId: string;
  group?: string;
}

interface UrlReferenceEntry {
  kind: 'url';
  id: string;
  url: string;
  title?: string;
  group?: string;
}

export type ReferenceEntry = NodeReferenceEntry | UrlReferenceEntry;

type ReferenceGroupKey = CanvasNode['type'] | 'url' | 'missing';

const REFERENCE_GROUP_ORDER: ReferenceGroupKey[] = [
  'file',
  'text',
  'image',
  'iframe',
  'url',
  'agent',
  'terminal',
  'mindmap',
  'shape',
  'frame',
  'group',
  'missing',
];

const PICKER_NODE_TYPE_GROUP_ORDER: CanvasNode['type'][] = [
  'iframe',
  'file',
  'text',
  'image',
  'agent',
  'terminal',
  'mindmap',
  'shape',
  'frame',
  'group',
];

const isUrlReference = (entry: ReferenceEntry): entry is UrlReferenceEntry => entry.kind === 'url';
const getReferenceId = (entry: ReferenceEntry) => isUrlReference(entry) ? entry.id : entry.nodeId;
const getReferenceGroupLabel = (type: ReferenceGroupKey) => {
  if (type === 'url') return 'URL';
  if (type === 'missing') return 'Missing nodes';
  return NODE_TYPE_LABELS[type];
};
const getReferenceGroupIcon = (type: ReferenceGroupKey) => {
  switch (type) {
    case 'file': return '📄';
    case 'text': return 'T';
    case 'image': return '🖼';
    case 'iframe': return '🌐';
    case 'url': return '🔗';
    case 'agent': return '🤖';
    case 'terminal': return '⌘';
    case 'mindmap': return '☊';
    case 'shape': return '◼';
    case 'frame': return '▣';
    case 'group': return '☷';
    case 'missing': return '?';
  }
};

const getUrlHostname = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const getUrlReferenceLabel = (entry: UrlReferenceEntry) => entry.title?.trim() || getUrlHostname(entry.url) || entry.url;

const createUrlPreviewNode = (entry: UrlReferenceEntry, drawerWidth: number): CanvasNode => ({
  id: entry.id,
  type: 'iframe',
  title: getUrlReferenceLabel(entry),
  x: 0,
  y: 0,
  width: Math.max(MIN_REFERENCE_DRAWER_WIDTH - 32, drawerWidth - 32),
  height: 420,
  data: {
    mode: 'url',
    url: entry.url,
    pageTitle: entry.title,
  },
});

const normalizeReferenceUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
};

interface ReferenceDrawerProps {
  open: boolean;
  references: ReferenceEntry[];
  activeReference?: ReferenceEntry;
  activeReferenceNode?: CanvasNode;
  nodes: CanvasNode[];
  selectedNode?: CanvasNode;
  onOpenChange: (open: boolean) => void;
  onSelectReference: (referenceId: string | undefined) => void;
  onRemoveReference: (referenceId: string) => void;
  onClearAll: () => void;
  onAddReference: (nodeId: string, group?: string) => void;
  onAddUrlReference: (url: string, title?: string) => void;
  onFocusNode: (nodeId: string) => void;
}

export const ReferenceDrawer = ({
  open,
  references,
  activeReference,
  activeReferenceNode,
  nodes,
  selectedNode,
  onOpenChange,
  onSelectReference,
  onRemoveReference,
  onClearAll,
  onAddReference,
  onAddUrlReference,
  onFocusNode,
}: ReferenceDrawerProps) => {
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_REFERENCE_DRAWER_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [shouldRender, setShouldRender] = useState(open);
  const [isActive, setIsActive] = useState(open);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [urlEditorOpen, setUrlEditorOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>();
  const [searchDraft, setSearchDraft] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const urlEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      const frame = window.requestAnimationFrame(() => setIsActive(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setIsActive(false);
    const timer = window.setTimeout(() => setShouldRender(false), 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchDraft.trim().toLowerCase());
    }, REFERENCE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [pickerOpen]);

  useEffect(() => {
    if (!urlEditorOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!urlEditorRef.current?.contains(event.target as Node)) {
        setUrlEditorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [urlEditorOpen]);

  const drawerStyle = useMemo(
    () => ({
      '--reference-drawer-width': `${drawerWidth}px`,
    }) as React.CSSProperties,
    [drawerWidth],
  );

  const handleResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startWidth = drawerWidth;
    setIsResizing(true);

    const handleMouseMove = (event: MouseEvent) => {
      const nextWidth = startWidth + event.clientX - startX;
      setDrawerWidth(Math.min(MAX_REFERENCE_DRAWER_WIDTH, Math.max(MIN_REFERENCE_DRAWER_WIDTH, nextWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [drawerWidth]);

  const nodeById = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const eligiblePickableNodes = useMemo(() => {
    const referenced = new Set(references.filter((entry) => !isUrlReference(entry)).map((entry) => entry.nodeId));
    return nodes
      .filter((node) => !referenced.has(node.id))
      .filter((node) => node.type !== 'frame' && node.type !== 'group');
  }, [nodes, references]);

  const pickableNodes = useMemo(() => {
    if (!debouncedSearch) return eligiblePickableNodes;
    return eligiblePickableNodes.filter((node) => {
      const label = getNodeDisplayLabel(node);
      const typeLabel = NODE_TYPE_LABELS[node.type] ?? node.type;
      return [label, node.type, typeLabel, node.id]
        .some((value) => value.toLowerCase().includes(debouncedSearch));
    });
  }, [eligiblePickableNodes, debouncedSearch]);

  const pickableNodeGroups = useMemo(() => {
    const map = new Map<CanvasNode['type'], CanvasNode[]>();
    for (const node of pickableNodes) {
      const list = map.get(node.type);
      if (list) list.push(node);
      else map.set(node.type, [node]);
    }

    return PICKER_NODE_TYPE_GROUP_ORDER
      .filter((type) => map.has(type))
      .map((type) => ({
        type,
        name: getReferenceGroupLabel(type),
        nodes: map.get(type) ?? [],
      }));
  }, [pickableNodes]);

  const handlePinSelected = useCallback(() => {
    if (!selectedNode) return;
    onAddReference(selectedNode.id);
  }, [selectedNode, onAddReference]);

  const handleAddFromPicker = useCallback((nodeId: string) => {
    onAddReference(nodeId);
    setPickerOpen(false);
  }, [onAddReference]);

  const handleAddUrl = useCallback(() => {
    const normalized = normalizeReferenceUrl(urlDraft);
    if (!normalized) {
      setUrlError('Enter a valid http(s) URL.');
      return;
    }
    onAddUrlReference(normalized, getUrlHostname(normalized) || normalized);
    setUrlDraft('');
    setUrlError(undefined);
    setUrlEditorOpen(false);
  }, [onAddUrlReference, urlDraft]);

  const activeReferenceId = activeReference ? getReferenceId(activeReference) : undefined;

  const openUrl = useCallback((url: string) => {
    void window.canvasWorkspace?.shell.openExternal(url);
  }, []);

  const copyUrl = useCallback((url: string) => {
    void copyTextToClipboard(url).catch(() => undefined);
  }, []);

  if (!shouldRender) return null;

  const hasReferences = references.length > 0;
  const searchActive = debouncedSearch.length > 0;
  const canPinSelected = !!selectedNode && !references.some((entry) => !isUrlReference(entry) && entry.nodeId === selectedNode.id);

  return (
    <aside
      className={`reference-drawer${isActive ? ' reference-drawer--open' : ''}${isResizing ? ' reference-drawer--resizing' : ''}`}
      style={drawerStyle}
      aria-hidden={!isActive}
    >
      <div
        className="reference-drawer-resize-handle"
        onMouseDown={handleResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize reference drawer"
        title="Drag to resize"
      />
      <header className="reference-drawer-header">
        <div>
          <div className="reference-drawer-kicker">Pinned context</div>
          <h2>Reference</h2>
        </div>
        <button
          className="reference-drawer-icon-button"
          type="button"
          onClick={() => onOpenChange(false)}
          title="Close reference panel"
          aria-label="Close reference panel"
        >
          ×
        </button>
      </header>

      <div className="reference-drawer-toolbar">
        <button
          className="reference-drawer-action"
          type="button"
          onClick={handlePinSelected}
          disabled={!canPinSelected}
          title={
            selectedNode
              ? canPinSelected
                ? `Pin "${getNodeDisplayLabel(selectedNode)}"`
                : 'Already pinned'
              : 'Select a node on the canvas first'
          }
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Pin selection
        </button>
        <div className="reference-picker-anchor" ref={pickerRef}>
          <button
            className={`reference-drawer-action reference-drawer-action--ghost${pickerOpen ? ' reference-drawer-action--open' : ''}`}
            type="button"
            onClick={() => setPickerOpen((prev) => !prev)}
            disabled={eligiblePickableNodes.length === 0}
            title={eligiblePickableNodes.length === 0 ? 'No more nodes to pin' : 'Pick a node to pin'}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M3 6h10M3 10h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            From canvas
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {pickerOpen && (
            <div className="reference-picker-popover" role="dialog" aria-label="Pick canvas reference">
              <div className="reference-picker-controls">
                <div className="reference-picker-search">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M7.1 12.2a5.1 5.1 0 100-10.2 5.1 5.1 0 000 10.2zM11 11l3 3"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  <input
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    placeholder="Search canvas nodes"
                    aria-label="Search canvas nodes"
                  />
                  {searchDraft && (
                    <button
                      type="button"
                      className="reference-search-clear"
                      onClick={() => setSearchDraft('')}
                      aria-label="Clear canvas node search"
                      title="Clear search"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="reference-picker-list" role="listbox">
                {pickableNodes.length === 0 ? (
                  <div className="reference-picker-empty">
                    {searchActive ? 'No canvas nodes match this search.' : 'All eligible nodes are pinned.'}
                  </div>
                ) : (
                  pickableNodeGroups.map((group) => (
                    <ReferencePickerGroupSection
                      key={group.type}
                      type={group.type}
                      name={group.name}
                      nodes={group.nodes}
                      onPick={handleAddFromPicker}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="reference-url-anchor" ref={urlEditorRef}>
          <button
            className={`reference-drawer-action reference-drawer-action--ghost${urlEditorOpen ? ' reference-drawer-action--open' : ''}`}
            type="button"
            onClick={() => {
              setUrlEditorOpen((prev) => !prev);
              setUrlError(undefined);
            }}
            aria-haspopup="dialog"
            aria-expanded={urlEditorOpen}
            title="Add URL reference"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M6.4 5.2l1.1-1.1a3 3 0 014.2 4.2l-1.2 1.2M9.6 10.8l-1.1 1.1a3 3 0 01-4.2-4.2l1.2-1.2M6.4 9.6l3.2-3.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
            URL
          </button>
          {urlEditorOpen && (
            <div className="reference-url-popover" role="dialog" aria-label="Add URL reference">
              <label className="reference-url-label" htmlFor="reference-url-input">Reference URL</label>
              <input
                id="reference-url-input"
                autoFocus
                className="reference-url-input"
                value={urlDraft}
                placeholder="https://example.com/article"
                onChange={(e) => {
                  setUrlDraft(e.target.value);
                  setUrlError(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddUrl();
                  } else if (e.key === 'Escape') {
                    setUrlEditorOpen(false);
                  }
                }}
              />
              {urlError && <div className="reference-url-error">{urlError}</div>}
              <div className="reference-url-actions">
                <button
                  type="button"
                  className="reference-drawer-secondary"
                  onClick={() => setUrlEditorOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="reference-drawer-primary"
                  onClick={handleAddUrl}
                  disabled={!urlDraft.trim()}
                >
                  Add URL
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="reference-drawer-content">
        {!hasReferences ? (
          <ReferenceEmptyState selectedNode={selectedNode} />
        ) : (
          <>
            <div className="reference-entry-list">
              <ReferenceEntryList
                entries={references}
                nodeById={nodeById}
                activeId={activeReferenceId}
                onSelect={onSelectReference}
                onFocus={onFocusNode}
                onOpenUrl={openUrl}
                onRemove={onRemoveReference}
              />
            </div>

            {activeReference && isUrlReference(activeReference) ? (
              <div className="reference-url-card reference-url-card--preview">
                <ReferenceUrlWebPreview reference={activeReference} drawerWidth={drawerWidth} />
                <div className="reference-card-footer">
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={() => openUrl(activeReference.url)}
                  >
                    Open
                  </button>
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={() => copyUrl(activeReference.url)}
                  >
                    Copy URL
                  </button>
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={() => onRemoveReference(activeReference.id)}
                  >
                    Unpin
                  </button>
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={onClearAll}
                    title="Remove all references"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            ) : activeReference && !isUrlReference(activeReference) && activeReferenceNode ? (
              <div className="reference-native-card">
                <ReferenceNativeNodePreview
                  node={activeReferenceNode}
                  drawerWidth={drawerWidth}
                  onFocusNode={onFocusNode}
                />
                <div className="reference-card-footer">
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={() => onFocusNode(activeReferenceNode.id)}
                    title="Focus on canvas"
                  >
                    Focus
                  </button>
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={() => onRemoveReference(activeReferenceNode.id)}
                  >
                    Unpin
                  </button>
                  <button
                    className="reference-drawer-secondary"
                    type="button"
                    onClick={onClearAll}
                    title="Remove all references"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            ) : (
              <div className="reference-pick-hint">Pick a reference above to preview it here.</div>
            )}
          </>
        )}
      </div>
    </aside>
  );
};


interface ReferenceUrlWebPreviewProps {
  reference: UrlReferenceEntry;
  drawerWidth: number;
}

const ReferenceUrlWebPreview = memo(({ reference, drawerWidth }: ReferenceUrlWebPreviewProps) => {
  const previewNode = useMemo(
    () => createUrlPreviewNode(reference, drawerWidth),
    [reference, drawerWidth],
  );

  return (
    <div className="reference-url-preview">
      <IframeNodeBody
        node={previewNode}
        onUpdate={() => undefined}
        isResizing={false}
        readOnly
      />
    </div>
  );
});

ReferenceUrlWebPreview.displayName = 'ReferenceUrlWebPreview';

interface ReferenceNativeNodePreviewProps {
  node: CanvasNode;
  drawerWidth: number;
  onFocusNode: (nodeId: string) => void;
}

const ReferenceNativeNodePreview = memo(({ node, drawerWidth, onFocusNode }: ReferenceNativeNodePreviewProps) => {
  const previewNode = useMemo(
    () => ({
      ...node,
      x: 0,
      y: 0,
      width: Math.max(MIN_REFERENCE_DRAWER_WIDTH - 32, drawerWidth - 32),
      height: 420,
    }),
    [drawerWidth, node],
  );

  const getPreviewNodes = useCallback(() => [node], [node]);
  const handleFocus = useCallback(() => onFocusNode(node.id), [node.id, onFocusNode]);

  return (
    <CanvasNodeView
      node={previewNode}
      getAllNodes={getPreviewNodes}
      isDragging={false}
      isResizing={false}
      isSelected={false}
      isHighlighted={false}
      onDragStart={() => undefined}
      onResizeStart={() => undefined}
      onUpdate={() => undefined}
      onAutoResize={() => undefined}
      onRemove={() => undefined}
      onExportMindmapImage={() => undefined}
      onSelect={() => undefined}
      onFocus={handleFocus}
      readOnly
    />
  );
});

ReferenceNativeNodePreview.displayName = 'ReferenceNativeNodePreview';

interface ReferenceEntryListProps {
  entries: ReferenceEntry[];
  nodeById: Map<string, CanvasNode>;
  activeId?: string;
  onSelect: (referenceId: string | undefined) => void;
  onFocus: (nodeId: string) => void;
  onOpenUrl: (url: string) => void;
  onRemove: (referenceId: string) => void;
}

const ReferenceEntryList = ({
  entries,
  nodeById,
  activeId,
  onSelect,
  onFocus,
  onOpenUrl,
  onRemove,
}: ReferenceEntryListProps) => (
  <ul className="reference-group-items">
    {entries.map((entry) => {
      const id = getReferenceId(entry);
      const node = isUrlReference(entry) ? undefined : nodeById.get(entry.nodeId);
      const label = isUrlReference(entry) ? getUrlReferenceLabel(entry) : node ? getNodeDisplayLabel(node) : entry.nodeId;
      const active = id === activeId;
      return (
        <li key={id}>
          <button
            type="button"
            className={`reference-group-item${active ? ' reference-group-item--active' : ''}`}
            onClick={() => onSelect(id)}
            onDoubleClick={() => isUrlReference(entry) ? onOpenUrl(entry.url) : onFocus(entry.nodeId)}
          >
            <span className="reference-group-item-label" title={label}>
              {label}
            </span>
            <span className="reference-group-item-type">{isUrlReference(entry) ? 'url' : node?.type ?? 'missing'}</span>
            <span
              className="reference-group-item-remove"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRemove(id);
                }
              }}
              aria-label="Remove from references"
              title="Remove"
            >
              ×
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

interface ReferencePickerGroupSectionProps {
  name: string;
  type: CanvasNode['type'];
  nodes: CanvasNode[];
  onPick: (nodeId: string) => void;
}

const ReferencePickerGroupSection = ({
  name,
  type,
  nodes,
  onPick,
}: ReferencePickerGroupSectionProps) => {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`reference-picker-group reference-group--type-${type}${collapsed ? ' reference-group--collapsed' : ''}`}>
      <button
        className="reference-group-header"
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
      >
        <svg
          className="reference-group-caret"
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 3l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="reference-group-type-icon" aria-hidden="true">{getReferenceGroupIcon(type)}</span>
        <span className="reference-group-name">{name}</span>
        <span className="reference-group-count">{nodes.length}</span>
      </button>
      {!collapsed && (
        <div className="reference-picker-group-items">
          {nodes.map((node) => (
            <button
              key={node.id}
              className="reference-picker-item"
              type="button"
              onClick={() => onPick(node.id)}
            >
              <span className="reference-picker-item-type">{node.type}</span>
              <span className="reference-picker-item-label">{getNodeDisplayLabel(node)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const ReferenceEmptyState = ({ selectedNode }: { selectedNode?: CanvasNode }) => (
  <div className="reference-empty">
    <div className="reference-empty-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path
          d="M5.2 2.8h7.6a1.4 1.4 0 011.4 1.4v10.6L9 11.8l-5.2 3V4.2a1.4 1.4 0 011.4-1.4z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <path d="M6.6 6.2h4.8M6.6 8.7h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </div>
    <h3>No reference pinned</h3>
    <p>Pin canvas nodes or URLs to keep them at hand. Use "Pin selection", "From canvas", or "URL" above.</p>
    {selectedNode ? (
      <div className="reference-selected-hint">
        <span>Selected</span>
        <strong>{getNodeDisplayLabel(selectedNode)}</strong>
      </div>
    ) : (
      <div className="reference-selected-hint reference-selected-hint--muted">
        Select a single node to enable "Pin selection", or add a URL directly.
      </div>
    )}
  </div>
);

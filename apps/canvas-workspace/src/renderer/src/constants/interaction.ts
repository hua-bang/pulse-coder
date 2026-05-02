import type { CanvasNode } from '../types';
import type { ShortcutSection } from '../types/ui-interaction';

type EmptyCanvasNodeType = Extract<CanvasNode['type'], 'agent' | 'terminal' | 'file'>;

export const DEFAULT_TOAST_DURATION_MS = 2800;

export const INTERACTION_ACTIONS = {
  workspaceCreate: 'workspace.create',
  workspaceRename: 'workspace.rename',
  workspaceDelete: 'workspace.delete',
  folderCreate: 'folder.create',
  folderRename: 'folder.rename',
  folderDelete: 'folder.delete',
  nodeRename: 'node.rename',
  nodeDelete: 'node.delete',
  nodeLinkCopy: 'node.link.copy',
  shortcutsOpen: 'shortcuts.open',
  emptyStateCreateAgent: 'empty-state.create-agent',
  emptyStateCreateTerminal: 'empty-state.create-terminal',
  emptyStateCreateNote: 'empty-state.create-note',
} as const;

export const NODE_TYPE_LABELS: Record<CanvasNode['type'], string> = {
  file: 'Note',
  terminal: 'Terminal',
  frame: 'Frame',
  agent: 'Agent',
  text: 'Text',
  iframe: 'Link',
  image: 'Image',
  shape: 'Shape',
  mindmap: 'Mindmap',
};

export const EMPTY_CANVAS_ACTIONS: Array<{
  actionKey: string;
  label: string;
  description: string;
  nodeType: EmptyCanvasNodeType;
}> = [
  {
    actionKey: INTERACTION_ACTIONS.emptyStateCreateAgent,
    label: 'Create Agent',
    description: 'Start a coding agent with canvas context.',
    nodeType: 'agent',
  },
  {
    actionKey: INTERACTION_ACTIONS.emptyStateCreateTerminal,
    label: 'Open Terminal',
    description: 'Run commands in the workspace shell.',
    nodeType: 'terminal',
  },
  {
    actionKey: INTERACTION_ACTIONS.emptyStateCreateNote,
    label: 'New Note',
    description: 'Capture ideas, plans, and summaries.',
    nodeType: 'file',
  },
];

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Canvas',
    items: [
      { combo: 'Right-click / Double-click', description: 'Open the create menu on blank canvas.' },
      { combo: 'Scroll', description: 'Pan the canvas.' },
      { combo: 'Ctrl/Cmd + Scroll', description: 'Zoom in or out.' },
      { combo: 'Ctrl/Cmd + K', description: 'Open node search.' },
      { combo: 'Ctrl/Cmd + H', description: 'Toggle node search.' },
      { combo: 'Ctrl/Cmd + Tab', description: 'Cycle through nodes.' },
    ],
  },
  {
    title: 'Edit',
    items: [
      { combo: 'Ctrl/Cmd + A', description: 'Select all nodes.' },
      { combo: 'Ctrl/Cmd + D', description: 'Duplicate the selected node.' },
      { combo: 'Ctrl/Cmd + C / V', description: 'Copy and paste selected nodes.' },
      { combo: 'Ctrl/Cmd + G', description: 'Wrap the selected nodes in a new frame.' },
      { combo: 'Delete / Backspace', description: 'Delete the current selection with confirmation.' },
      { combo: 'Ctrl/Cmd + Z', description: 'Undo the last change.' },
      { combo: 'Ctrl/Cmd + Shift + Z', description: 'Redo the last undone change.' },
    ],
  },
  {
    title: 'Panels',
    items: [
      { combo: 'Ctrl/Cmd + Shift + A', description: 'Toggle the side chat panel.' },
      { combo: 'Ctrl/Cmd + Shift + L', description: 'Open or close the full chat page.' },
      { combo: '?', description: 'Open this shortcuts panel.' },
      { combo: 'Esc', description: 'Close open overlays or return from chat page.' },
    ],
  },
];

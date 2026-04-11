import type { MentionItem, QuickAction } from './types';

export const CANVAS_MENTION_PREFIX = 'canvas:';

export const MENTION_GROUPS = [
  { key: 'file', label: 'File' },
  { key: 'agent', label: 'Agent' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'frame', label: 'Frame' },
  { key: 'canvas', label: 'Canvas' },
  { key: 'proj-file', label: 'Project Files' },
] as const;

export type MentionGroupKey = (typeof MENTION_GROUPS)[number]['key'];

export const MENTION_GROUP_ORDER: MentionGroupKey[] = MENTION_GROUPS.map(group => group.key);

export const MENTION_GROUP_LABEL: Record<MentionGroupKey, string> = Object.fromEntries(
  MENTION_GROUPS.map(group => [group.key, group.label]),
) as Record<MentionGroupKey, string>;

export const MENTION_MAX_ITEMS = 30;

export const QUICK_ACTIONS: QuickAction[] = [
  {
    key: 'overview',
    label: 'What’s on the canvas?',
    prompt: 'What’s on the canvas? Give me an overview.',
  },
  {
    key: 'note',
    label: 'Create a new note',
    prompt: 'Create a new note on the canvas.',
  },
  {
    key: 'summarize',
    label: 'Summarize my notes',
    prompt: 'Summarize all the notes on my canvas.',
  },
  {
    key: 'command',
    label: 'Run a command',
    prompt: '',
  },
];

export function getMentionGroupKey(item: MentionItem): MentionGroupKey {
  if (item.type === 'workspace') return 'canvas';
  if (item.type === 'file') return 'proj-file';

  switch (item.nodeType) {
    case 'agent':
      return 'agent';
    case 'terminal':
      return 'terminal';
    case 'frame':
      return 'frame';
    case 'file':
    default:
      return 'file';
  }
}

import type { Editor } from '@tiptap/react';
import type { SlashCommandDef } from '../components/SlashCommandMenu';

export interface SlashCmd extends SlashCommandDef {
  run: (editor: Editor, from: number, to: number) => void;
}

export const ALL_SLASH_COMMANDS: SlashCmd[] = [
  {
    id: 'text', label: 'Text', desc: 'Plain paragraph', icon: 'T',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).clearNodes().run(),
  },
  {
    id: 'h1', label: 'Heading 1', desc: 'Large section heading', icon: 'H1',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2', label: 'Heading 2', desc: 'Medium section heading', icon: 'H2',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3', label: 'Heading 3', desc: 'Small section heading', icon: 'H3',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'ul', label: 'Bullet List', desc: 'Unordered list', icon: '•',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleBulletList().run(),
  },
  {
    id: 'ol', label: 'Numbered List', desc: 'Ordered list', icon: '1.',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleOrderedList().run(),
  },
  {
    id: 'task', label: 'Task List', desc: 'Todo checklist', icon: '☑',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleTaskList().run(),
  },
  {
    id: 'quote', label: 'Blockquote', desc: 'Quote / callout block', icon: '"',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleBlockquote().run(),
  },
  {
    id: 'code', label: 'Code Block', desc: 'Code snippet', icon: '</>',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleCodeBlock().run(),
  },
  {
    id: 'hr', label: 'Divider', desc: 'Horizontal line', icon: '—',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).setHorizontalRule().run(),
  },
];

export const filterCmds = (query: string): SlashCmd[] => {
  if (!query) return ALL_SLASH_COMMANDS;
  const q = query.toLowerCase();
  return ALL_SLASH_COMMANDS.filter(
    (c) => c.label.toLowerCase().includes(q) || c.id.includes(q) || c.desc.toLowerCase().includes(q),
  );
};

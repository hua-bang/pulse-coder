import type { Editor } from '@tiptap/react';
import type { SlashCommandDef } from '../components/SlashCommandMenu';

export interface SlashCmdContext {
  /** Called when a command needs the user to supply a URL (link, etc.). */
  requestLink?: (initial: string) => void;
  /** Called when a command needs to pick an image file to insert. */
  requestImage?: () => void;
}

export interface SlashCmd extends SlashCommandDef {
  run: (editor: Editor, from: number, to: number, ctx?: SlashCmdContext) => void;
}

const deleteSlash = (e: Editor, f: number, t: number) =>
  e.chain().focus().deleteRange({ from: f, to: t });

export const ALL_SLASH_COMMANDS: SlashCmd[] = [
  {
    id: 'text', label: 'Text', desc: 'Plain paragraph', icon: 'T',
    run: (e, f, t) => deleteSlash(e, f, t).clearNodes().run(),
  },
  {
    id: 'h1', label: 'Heading 1', desc: 'Large section heading', icon: 'H1',
    run: (e, f, t) => deleteSlash(e, f, t).toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2', label: 'Heading 2', desc: 'Medium section heading', icon: 'H2',
    run: (e, f, t) => deleteSlash(e, f, t).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3', label: 'Heading 3', desc: 'Small section heading', icon: 'H3',
    run: (e, f, t) => deleteSlash(e, f, t).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'ul', label: 'Bullet List', desc: 'Unordered list', icon: '•',
    run: (e, f, t) => deleteSlash(e, f, t).toggleBulletList().run(),
  },
  {
    id: 'ol', label: 'Numbered List', desc: 'Ordered list', icon: '1.',
    run: (e, f, t) => deleteSlash(e, f, t).toggleOrderedList().run(),
  },
  {
    id: 'task', label: 'Task List', desc: 'Todo checklist', icon: '☑',
    run: (e, f, t) => deleteSlash(e, f, t).toggleTaskList().run(),
  },
  {
    id: 'quote', label: 'Blockquote', desc: 'Quote / callout block', icon: '"',
    run: (e, f, t) => deleteSlash(e, f, t).toggleBlockquote().run(),
  },
  {
    id: 'code', label: 'Code Block', desc: 'Code snippet with syntax highlight', icon: '</>',
    run: (e, f, t) => deleteSlash(e, f, t).toggleCodeBlock().run(),
  },
  {
    id: 'table', label: 'Table', desc: 'Insert 3×3 table', icon: '▦',
    run: (e, f, t) =>
      deleteSlash(e, f, t).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'link', label: 'Link', desc: 'Insert hyperlink on selection', icon: '🔗',
    run: (e, f, t, ctx) => {
      deleteSlash(e, f, t).run();
      const prev = (e.getAttributes('link')?.href as string | undefined) ?? '';
      if (ctx?.requestLink) {
        ctx.requestLink(prev);
      } else {
        // Fallback prompt
        const url = window.prompt('URL', prev);
        if (url === null) return;
        if (url === '') {
          e.chain().focus().extendMarkRange('link').unsetLink().run();
        } else {
          e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }
      }
    },
  },
  {
    id: 'highlight', label: 'Highlight', desc: 'Mark selection as highlighted', icon: '🖍',
    run: (e, f, t) => deleteSlash(e, f, t).toggleHighlight().run(),
  },
  {
    id: 'underline', label: 'Underline', desc: 'Underline selection', icon: 'U',
    run: (e, f, t) => deleteSlash(e, f, t).toggleUnderline().run(),
  },
  {
    id: 'strike', label: 'Strikethrough', desc: 'Cross out selection', icon: 'S',
    run: (e, f, t) => deleteSlash(e, f, t).toggleStrike().run(),
  },
  {
    id: 'image', label: 'Image', desc: 'Insert image from disk', icon: '🖼',
    run: (e, f, t, ctx) => {
      deleteSlash(e, f, t).run();
      ctx?.requestImage?.();
    },
  },
  {
    id: 'hr', label: 'Divider', desc: 'Horizontal line', icon: '—',
    run: (e, f, t) => deleteSlash(e, f, t).setHorizontalRule().run(),
  },
];

export const filterCmds = (query: string): SlashCmd[] => {
  if (!query) return ALL_SLASH_COMMANDS;
  const q = query.toLowerCase();
  return ALL_SLASH_COMMANDS.filter(
    (c) => c.label.toLowerCase().includes(q) || c.id.includes(q) || c.desc.toLowerCase().includes(q),
  );
};

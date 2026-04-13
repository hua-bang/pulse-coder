import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface NoteSearchMatch {
  from: number;
  to: number;
}

export interface NoteSearchState {
  query: string;
  current: number;
  matches: NoteSearchMatch[];
  decorations: DecorationSet;
}

export const noteSearchPluginKey = new PluginKey<NoteSearchState>('noteSearch');

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findMatches = (doc: PMNode, query: string): NoteSearchMatch[] => {
  if (!query) return [];
  const matches: NoteSearchMatch[] = [];
  const re = new RegExp(escapeRegex(query), 'gi');
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.text)) !== null) {
      matches.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
  });
  return matches;
};

const buildDecorations = (matches: NoteSearchMatch[], current: number, doc: PMNode): DecorationSet => {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? 'note-search-match note-search-match--active' : 'note-search-match',
    }),
  );
  return DecorationSet.create(doc, decos);
};

const emptyState = (): NoteSearchState => ({
  query: '',
  current: 0,
  matches: [],
  decorations: DecorationSet.empty,
});

export const NoteSearchExtension = Extension.create({
  name: 'noteSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin<NoteSearchState>({
        key: noteSearchPluginKey,
        state: {
          init: () => emptyState(),
          apply(tr, old) {
            const meta = tr.getMeta(noteSearchPluginKey) as
              | { type: 'set'; query: string }
              | { type: 'navigate'; direction: 1 | -1 }
              | { type: 'setCurrent'; current: number }
              | { type: 'clear' }
              | undefined;
            if (meta) {
              if (meta.type === 'clear') return emptyState();
              if (meta.type === 'set') {
                const matches = findMatches(tr.doc, meta.query);
                const current = matches.length === 0 ? 0 : 0;
                return {
                  query: meta.query,
                  current,
                  matches,
                  decorations: buildDecorations(matches, current, tr.doc),
                };
              }
              if (meta.type === 'setCurrent') {
                if (old.matches.length === 0) return old;
                const current = Math.max(0, Math.min(meta.current, old.matches.length - 1));
                return { ...old, current, decorations: buildDecorations(old.matches, current, tr.doc) };
              }
              if (meta.type === 'navigate') {
                if (old.matches.length === 0) return old;
                const current =
                  (old.current + meta.direction + old.matches.length) % old.matches.length;
                return { ...old, current, decorations: buildDecorations(old.matches, current, tr.doc) };
              }
            }
            if (tr.docChanged && old.query) {
              const matches = findMatches(tr.doc, old.query);
              const current = matches.length === 0 ? 0 : Math.min(old.current, matches.length - 1);
              return {
                query: old.query,
                current,
                matches,
                decorations: buildDecorations(matches, current, tr.doc),
              };
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            return noteSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export const getNoteSearchState = (state: EditorState): NoteSearchState | null =>
  noteSearchPluginKey.getState(state) ?? null;

export const setNoteSearch = (view: EditorView, query: string) => {
  view.dispatch(view.state.tr.setMeta(noteSearchPluginKey, { type: 'set', query }));
};

export const clearNoteSearch = (view: EditorView) => {
  view.dispatch(view.state.tr.setMeta(noteSearchPluginKey, { type: 'clear' }));
};

const scrollMatchIntoView = (view: EditorView, match: NoteSearchMatch) => {
  try {
    const coords = view.coordsAtPos(match.from);
    const container = view.dom.closest<HTMLElement>('.note-tiptap-editor');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const margin = 40;
    if (coords.top < rect.top + margin) {
      container.scrollTop += coords.top - rect.top - margin;
    } else if (coords.bottom > rect.bottom - margin) {
      container.scrollTop += coords.bottom - rect.bottom + margin;
    }
  } catch {
    // ignore pos resolution errors
  }
};

export const navigateNoteSearch = (view: EditorView, direction: 1 | -1) => {
  const s = getNoteSearchState(view.state);
  if (!s || s.matches.length === 0) return;
  const next = (s.current + direction + s.matches.length) % s.matches.length;
  view.dispatch(view.state.tr.setMeta(noteSearchPluginKey, { type: 'navigate', direction }));
  const target = s.matches[next];
  if (target) scrollMatchIntoView(view, target);
};

export const replaceCurrentMatch = (view: EditorView, replacement: string): boolean => {
  const s = getNoteSearchState(view.state);
  if (!s || s.matches.length === 0) return false;
  const target = s.matches[s.current];
  if (!target) return false;
  const tr = view.state.tr.insertText(replacement, target.from, target.to);
  tr.setMeta(noteSearchPluginKey, { type: 'set', query: s.query });
  view.dispatch(tr);
  return true;
};

export const replaceAllMatches = (view: EditorView, replacement: string): number => {
  const s = getNoteSearchState(view.state);
  if (!s || s.matches.length === 0) return 0;
  let tr = view.state.tr;
  // Replace from last to first so positions stay valid
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    tr = tr.insertText(replacement, m.from, m.to);
  }
  tr.setMeta(noteSearchPluginKey, { type: 'set', query: s.query });
  view.dispatch(tr);
  return s.matches.length;
};

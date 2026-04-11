import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(content: string): string {
  return markdown.render(content);
}

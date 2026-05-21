import { createElement, type ReactNode } from 'react';
import type { CanvasNode } from '../../../types';
import { CANVAS_MENTION_PREFIX, SKILL_MENTION_PREFIX } from '../constants';
import type { MentionItem, WorkspaceOption } from '../types';
import { renderMarkdown } from './markdown';

const MENTION_RE = /@\[([^\]]+)\]/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mentionIconSvg(nodeType: string): string {
  switch (nodeType) {
    case 'terminal':
      return '<rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2 1.5L4 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>';
    case 'agent':
      return '<circle cx="7" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 12c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    case 'frame':
      return '<rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/>';
    case 'group':
      return '<rect x="2" y="2.5" width="10" height="9" rx="1.8" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/><path d="M4.5 5.5h5M4.5 8.5h5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
    case 'text':
      return '<path d="M3 3.5h8M7 3.5v7M5.5 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
    case 'iframe':
      return '<circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M2 7h10M7 2c1.7 1.7 1.7 8.3 0 10M7 2c-1.7 1.7-1.7 8.3 0 10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
    case 'mindmap':
      return '<circle cx="3.5" cy="7" r="1.2" stroke="currentColor" stroke-width="1.1"/><circle cx="10.5" cy="3.5" r="1.1" stroke="currentColor" stroke-width="1.1"/><circle cx="10.5" cy="7" r="1.1" stroke="currentColor" stroke-width="1.1"/><circle cx="10.5" cy="10.5" r="1.1" stroke="currentColor" stroke-width="1.1"/><path d="M4.7 7L9.4 3.7M4.7 7H9.4M4.7 7L9.4 10.3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
    case 'workspace':
      return '<rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="3.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/><rect x="7.5" y="3.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/><rect x="3.5" y="7.5" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1"/>';
    case 'skill':
      return '<path d="M7 1.5l1.6 3.4 3.7.5-2.7 2.5.7 3.6L7 9.8l-3.3 1.7.7-3.6L1.7 5.4l3.7-.5L7 1.5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>';
    default:
      return '<rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5h5M4.5 7.5h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>';
  }
}

export function MentionNodeIcon({ nodeType, size = 12 }: { nodeType: string; size?: number }) {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    fill: 'none',
    dangerouslySetInnerHTML: { __html: mentionIconSvg(nodeType) },
  });
}

export function getMentionNodeType(item: MentionItem, nodes?: CanvasNode[]): string {
  if (item.type === 'skill') return 'skill';
  if (item.type === 'workspace') return 'workspace';
  if (item.type === 'node') return item.nodeType ?? 'file';

  return nodes?.find(node => node.title === item.label)?.type ?? item.nodeType ?? 'file';
}

export function extractMentionedWorkspaceIds(
  text: string,
  allWorkspaces: WorkspaceOption[] | undefined,
  currentWorkspaceId: string,
): string[] {
  if (!allWorkspaces || allWorkspaces.length === 0) return [];

  const re = new RegExp(`@\\[${CANVAS_MENTION_PREFIX}([^\\]]+)\\]`, 'g');
  const ids = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const workspaceName = match[1];
    const workspace = allWorkspaces.find(item => item.name === workspaceName);
    if (workspace && workspace.id !== currentWorkspaceId) {
      ids.add(workspace.id);
    }
  }

  return Array.from(ids);
}

export function serializeEditable(element: HTMLElement): string {
  let text = '';

  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
      continue;
    }

    if (!(child instanceof HTMLElement)) {
      continue;
    }

    if (child.dataset.mention) {
      text += `@[${child.dataset.mention}]`;
      continue;
    }

    if (child.tagName === 'BR') {
      text += '\n';
      continue;
    }

    text += serializeEditable(child);
  }

  return text;
}

export function createMentionChipElement(item: MentionItem, nodes?: CanvasNode[]): HTMLSpanElement {
  const isWorkspace = item.type === 'workspace';
  const isSkill = item.type === 'skill';
  const nodeType = getMentionNodeType(item, nodes);
  const chip = document.createElement('span');

  const classes = ['chat-mention-chip', 'chat-mention-chip--input'];
  if (isWorkspace) classes.push('chat-mention-chip--workspace');
  if (isSkill) classes.push('chat-mention-chip--skill');
  chip.className = classes.join(' ');
  chip.contentEditable = 'false';
  chip.dataset.mention = isWorkspace
    ? `${CANVAS_MENTION_PREFIX}${item.label}`
    : isSkill
      ? `${SKILL_MENTION_PREFIX}${item.label}`
      : item.label;
  chip.dataset.nodeType = nodeType;

  if (isWorkspace && item.workspaceId) {
    chip.dataset.workspaceId = item.workspaceId;
  }

  if (!isSkill) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'chat-mention-chip-icon';
    iconSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg(nodeType)}</svg>`;
    chip.appendChild(iconSpan);
  }

  const labelSpan = document.createElement('span');
  labelSpan.className = 'chat-mention-chip-label';
  labelSpan.textContent = item.label;
  chip.appendChild(labelSpan);

  return chip;
}

export function renderUserContent(content: string, nodes?: CanvasNode[]): ReactNode {
  const parts: ReactNode[] = [];
  const re = new RegExp(MENTION_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    const rawLabel = match[1];
    if (rawLabel.startsWith(CANVAS_MENTION_PREFIX)) {
      const workspaceLabel = rawLabel.slice(CANVAS_MENTION_PREFIX.length);
      parts.push(
        createElement(
          'span',
          {
            key: match.index,
            className: 'chat-mention-chip chat-mention-chip--workspace',
            'data-node-type': 'workspace',
          } as any,
          createElement(
            'span',
            { className: 'chat-mention-chip-icon' },
            createElement(MentionNodeIcon, { nodeType: 'workspace' }),
          ),
          createElement('span', { className: 'chat-mention-chip-label' }, workspaceLabel),
        ),
      );
      lastIndex = re.lastIndex;
      continue;
    }

    if (rawLabel.startsWith(SKILL_MENTION_PREFIX)) {
      const skillLabel = rawLabel.slice(SKILL_MENTION_PREFIX.length);
      parts.push(
        createElement(
          'span',
          {
            key: match.index,
            className: 'chat-mention-chip chat-mention-chip--skill',
            'data-node-type': 'skill',
          } as any,
          createElement('span', { className: 'chat-mention-chip-label' }, skillLabel),
        ),
      );
      lastIndex = re.lastIndex;
      continue;
    }

    const node = nodes?.find(item => item.title === rawLabel);
    parts.push(
      createElement(
        'span',
        {
          key: match.index,
          className: 'chat-mention-chip chat-mention-chip--clickable',
          'data-node-type': node?.type,
          'data-node-id': node?.id,
        } as any,
        createElement(
          'span',
          { className: 'chat-mention-chip-icon' },
          createElement(MentionNodeIcon, { nodeType: node?.type ?? 'file' }),
        ),
        createElement('span', { className: 'chat-mention-chip-label' }, rawLabel),
      ),
    );
    lastIndex = re.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

export function renderMdWithMentions(content: string, nodes?: CanvasNode[]): string {
  const html = renderMarkdown(content);

  return html.replace(MENTION_RE, (_match, rawLabel: string) => {
    if (rawLabel.startsWith(CANVAS_MENTION_PREFIX)) {
      const workspaceLabel = rawLabel.slice(CANVAS_MENTION_PREFIX.length);
      return `<span class="chat-mention-chip chat-mention-chip--workspace" data-node-type="workspace"><span class="chat-mention-chip-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg('workspace')}</svg></span><span class="chat-mention-chip-label">${escapeHtml(workspaceLabel)}</span></span>`;
    }

    if (rawLabel.startsWith(SKILL_MENTION_PREFIX)) {
      const skillLabel = rawLabel.slice(SKILL_MENTION_PREFIX.length);
      return `<span class="chat-mention-chip chat-mention-chip--skill" data-node-type="skill"><span class="chat-mention-chip-label">${escapeHtml(skillLabel)}</span></span>`;
    }

    const node = nodes?.find(item => item.title === rawLabel);
    const nodeType = node?.type ?? 'file';
    const nodeId = node?.id ?? '';
    return `<span class="chat-mention-chip chat-mention-chip--clickable" data-node-type="${escapeHtml(nodeType)}" data-node-id="${escapeHtml(nodeId)}"><span class="chat-mention-chip-icon"><svg width="12" height="12" viewBox="0 0 14 14" fill="none">${mentionIconSvg(nodeType)}</svg></span><span class="chat-mention-chip-label">${escapeHtml(rawLabel)}</span></span>`;
  });
}

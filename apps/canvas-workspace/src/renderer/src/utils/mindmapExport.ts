import type { CanvasNode, MindmapNodeData } from '../types';
import { layoutMindmap, type MindmapLayout, type LaidOutTopic } from './mindmapLayout';

const EXPORT_MARGIN = 28;
const EXPORT_SCALE = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export interface MindmapImageExport {
  data: string;
  fileName: string;
  width: number;
  height: number;
}

const escapeXml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sanitizeFileName = (value: string) => {
  const trimmed = value
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'mindmap';
};

const getTopicLabel = (topic: LaidOutTopic) => topic.text.trim() || 'Untitled';

const renderTopic = (topic: LaidOutTopic) => {
  const isRoot = topic.depth === 0;
  const fontSize = isRoot ? 20 : 14;
  const fontWeight = isRoot ? 500 : 400;
  const justify = isRoot ? 'center' : 'flex-start';
  const padding = isRoot ? '0 10px' : '0 8px';
  const label = escapeXml(getTopicLabel(topic));
  const toggle = !isRoot && topic.hasChildren
    ? `<circle cx="${topic.x + topic.width - 2}" cy="${topic.y + topic.height / 2 + 3}" r="3" fill="${escapeXml(topic.color)}" opacity="${topic.collapsed ? '0.9' : '0.18'}" stroke="${escapeXml(topic.color)}" stroke-width="1" />`
    : '';

  return `
    <foreignObject x="${topic.x}" y="${topic.y}" width="${topic.width}" height="${topic.height}">
      <div xmlns="${XHTML_NS}" style="box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:${justify};padding:${padding};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:${fontSize}px;font-weight:${fontWeight};line-height:1.3;color:#1f2328;white-space:${isRoot ? 'nowrap' : 'pre-wrap'};overflow-wrap:break-word;">
        <span style="display:block;max-width:100%;">${label}</span>
      </div>
    </foreignObject>
    ${toggle}`;
};

const renderMindmapSvg = (layout: MindmapLayout, width: number, height: number) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <g transform="translate(${EXPORT_MARGIN} ${EXPORT_MARGIN})">
    ${layout.branches.map((branch) => `
      <path d="${escapeXml(branch.path)}" fill="none" stroke="${escapeXml(branch.color)}" stroke-width="2" stroke-linecap="round" opacity="0.85" />
    `).join('')}
    ${layout.topics.map(renderTopic).join('')}
  </g>
</svg>`;

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Failed to render mindmap SVG.'));
  image.src = src;
});

export const exportMindmapNodeToPng = async (node: CanvasNode): Promise<MindmapImageExport> => {
  const data = node.data as MindmapNodeData;
  const layout = layoutMindmap(data.root);
  const width = Math.ceil(layout.width + EXPORT_MARGIN * 2);
  const height = Math.ceil(layout.height + EXPORT_MARGIN * 2);
  const svg = renderMindmapSvg(layout, width, height);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width * EXPORT_SCALE;
    canvas.height = height * EXPORT_SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable.');
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
    ctx.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    if (!base64) throw new Error('Failed to encode exported image.');

    const name = sanitizeFileName(node.title || data.root.text || 'mindmap');
    return {
      data: base64,
      fileName: `${name}.png`,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
};

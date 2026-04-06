import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveCanvas, loadCanvas } from '../store';
import { readNode, writeNode, createNode, deleteNode, getNodeCapabilities } from '../nodes';
import type { CanvasSaveData, CanvasNode } from '../types';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `canvas-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

function makeCanvas(nodes: CanvasNode[]): CanvasSaveData {
  return {
    nodes,
    transform: { x: 0, y: 0, scale: 1 },
    savedAt: '2025-01-01T00:00:00.000Z',
  };
}

function makeFileNode(id: string, content: string, filePath?: string): CanvasNode {
  return {
    id,
    type: 'file',
    title: 'Test File',
    x: 0, y: 0, width: 420, height: 360,
    data: { content, filePath: filePath ?? '' },
  };
}

function makeFrameNode(id: string, label: string, color: string): CanvasNode {
  return {
    id,
    type: 'frame',
    title: 'Test Frame',
    x: 0, y: 0, width: 600, height: 400,
    data: { label, color },
  };
}

function makeTerminalNode(id: string): CanvasNode {
  return {
    id,
    type: 'terminal',
    title: 'Test Terminal',
    x: 0, y: 0, width: 480, height: 300,
    data: { sessionId: '', cwd: '/home/user', scrollback: 'ls\nfile.txt' },
  };
}

function makeAgentNode(id: string, agentType = 'codex', agentCommand = 'codex'): CanvasNode {
  return {
    id,
    type: 'agent',
    title: 'Test Agent',
    x: 0, y: 0, width: 520, height: 360,
    data: { sessionId: '', cwd: '/home/user', scrollback: '', agentType, agentCommand },
  };
}

describe('getNodeCapabilities', () => {
  it('returns correct capabilities', () => {
    expect(getNodeCapabilities('file')).toEqual(['read', 'write']);
    expect(getNodeCapabilities('terminal')).toEqual(['read', 'exec']);
    expect(getNodeCapabilities('frame')).toEqual(['read', 'write']);
    expect(getNodeCapabilities('agent')).toEqual(['read', 'exec']);
  });
});

describe('readNode', () => {
  it('reads file node with in-memory content', async () => {
    const node = makeFileNode('n1', 'hello world');
    const result = await readNode(node);
    expect(result.type).toBe('file');
    expect(result.content).toBe('hello world');
  });

  it('reads file node from disk when filePath exists', async () => {
    const filePath = join(testDir, 'test.md');
    await fs.writeFile(filePath, 'disk content', 'utf-8');
    const node = makeFileNode('n1', 'in-memory', filePath);
    const result = await readNode(node);
    expect(result.content).toBe('disk content');
  });

  it('reads terminal node', async () => {
    const node = makeTerminalNode('t1');
    const result = await readNode(node);
    expect(result.type).toBe('terminal');
    expect(result.cwd).toBe('/home/user');
    expect(result.scrollback).toBe('ls\nfile.txt');
  });

  it('reads frame node', async () => {
    const node = makeFrameNode('f1', 'Important', '#ff0000');
    const result = await readNode(node);
    expect(result.type).toBe('frame');
    expect(result.label).toBe('Important');
    expect(result.color).toBe('#ff0000');
  });

  it('reads agent node', async () => {
    const node = makeAgentNode('a1', 'codex', 'codex');
    const result = await readNode(node);
    expect(result.type).toBe('agent');
    expect(result.agentType).toBe('codex');
    expect(result.agentCommand).toBe('codex');
    expect(result.cwd).toBe('/home/user');
  });
});

describe('writeNode', () => {
  it('writes to file node in-memory', async () => {
    const canvas = makeCanvas([makeFileNode('n1', 'old')]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await writeNode('ws-1', 'n1', 'new content', testDir);
    expect(result.ok).toBe(true);

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes[0].data.content).toBe('new content');
  });

  it('writes to frame node with JSON', async () => {
    const canvas = makeCanvas([makeFrameNode('f1', 'old', '#000')]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await writeNode('ws-1', 'f1', '{"label":"new label","color":"#fff"}', testDir);
    expect(result.ok).toBe(true);

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes[0].data.label).toBe('new label');
    expect(updated!.nodes[0].data.color).toBe('#fff');
  });

  it('rejects write to terminal node', async () => {
    const canvas = makeCanvas([makeTerminalNode('t1')]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await writeNode('ws-1', 't1', 'hello', testDir);
    expect(result.ok).toBe(false);
  });

  it('rejects write to agent node', async () => {
    const canvas = makeCanvas([makeAgentNode('a1')]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await writeNode('ws-1', 'a1', 'hello', testDir);
    expect(result.ok).toBe(false);
  });

  it('returns error for missing workspace', async () => {
    const result = await writeNode('nonexistent', 'n1', 'data', testDir);
    expect(result.ok).toBe(false);
  });
});

describe('createNode', () => {
  it('creates a file node with notes file', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', { type: 'file', title: 'New File' }, testDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.type).toBe('file');
    expect(result.data.title).toBe('New File');

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes).toHaveLength(1);
    expect(updated!.nodes[0].id).toBe(result.data.nodeId);

    // File node should have a valid filePath pointing to a notes file
    const filePath = updated!.nodes[0].data.filePath as string;
    expect(filePath).toBeTruthy();
    expect(filePath).toContain('notes');
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);
    expect(updated!.nodes[0].data.saved).toBe(true);
  });

  it('creates a frame node with data', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', {
      type: 'frame',
      title: 'Group',
      data: { color: '#ff0000', label: 'Core' },
    }, testDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes[0].data.color).toBe('#ff0000');
    expect(updated!.nodes[0].data.label).toBe('Core');
  });

  it('auto-places nodes to the right', async () => {
    const canvas = makeCanvas([
      { ...makeFileNode('n1', ''), x: 100, y: 200, width: 420 } as CanvasNode,
    ]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', { type: 'frame' }, testDir);
    expect(result.ok).toBe(true);

    const updated = await loadCanvas('ws-1', testDir);
    const newNode = updated!.nodes[1];
    expect(newNode.x).toBe(560); // 100 + 420 + 40
    expect(newNode.y).toBe(200); // aligned with rightmost node's y
  });

  it('auto-creates canvas if not exists', async () => {
    // Don't pre-create canvas.json — createNode should handle it
    const result = await createNode('ws-new', { type: 'frame', title: 'First' }, testDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const canvas = await loadCanvas('ws-new', testDir);
    expect(canvas).not.toBeNull();
    expect(canvas!.nodes).toHaveLength(1);
    expect(canvas!.nodes[0].title).toBe('First');
  });

  it('creates an agent node with default codex preset', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', {
      type: 'agent',
      title: 'My Agent',
    }, testDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.type).toBe('agent');
    expect(result.data.title).toBe('My Agent');

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes).toHaveLength(1);
    expect(updated!.nodes[0].data.agentType).toBe('codex');
    expect(updated!.nodes[0].data.agentCommand).toBe('codex');
  });

  it('creates an agent node with explicit agent type', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', {
      type: 'agent',
      title: 'Claude Agent',
      data: { agentType: 'claude-code' },
    }, testDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes[0].data.agentType).toBe('claude-code');
    expect(updated!.nodes[0].data.agentCommand).toBe('claude');
  });

  it('creates file node with initial content', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await createNode('ws-1', {
      type: 'file',
      title: 'Note',
      data: { content: '# Hello World' },
    }, testDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const updated = await loadCanvas('ws-1', testDir);
    const filePath = updated!.nodes[0].data.filePath as string;
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('# Hello World');
  });
});

describe('deleteNode', () => {
  it('removes node from canvas', async () => {
    const canvas = makeCanvas([makeFileNode('n1', 'keep'), makeFileNode('n2', 'delete')]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await deleteNode('ws-1', 'n2', testDir);
    expect(result.ok).toBe(true);

    const updated = await loadCanvas('ws-1', testDir);
    expect(updated!.nodes).toHaveLength(1);
    expect(updated!.nodes[0].id).toBe('n1');
  });

  it('returns error for missing node', async () => {
    const canvas = makeCanvas([]);
    await saveCanvas('ws-1', canvas, testDir);

    const result = await deleteNode('ws-1', 'nonexistent', testDir);
    expect(result.ok).toBe(false);
  });
});

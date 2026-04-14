import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadCanvas,
  saveCanvas,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  listWorkspaceIds,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceDir,
  ensureWorkspaceDir,
  commitNodeMutation,
  CanvasWipeRefusedError,
} from '../store';
import type { CanvasNode, CanvasSaveData } from '../types';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `canvas-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const emptyCanvas: CanvasSaveData = {
  nodes: [],
  transform: { x: 0, y: 0, scale: 1 },
  savedAt: '2025-01-01T00:00:00.000Z',
};

describe('store', () => {
  describe('workspace manifest', () => {
    it('returns empty manifest when none exists', async () => {
      const manifest = await loadWorkspaceManifest(testDir);
      expect(manifest.workspaces).toEqual([]);
    });

    it('saves and loads manifest', async () => {
      const manifest = { workspaces: [{ id: 'ws-1', name: 'Test' }] };
      await saveWorkspaceManifest(manifest, testDir);
      const loaded = await loadWorkspaceManifest(testDir);
      expect(loaded.workspaces).toEqual([{ id: 'ws-1', name: 'Test' }]);
    });
  });

  describe('canvas CRUD', () => {
    it('returns null for non-existent canvas', async () => {
      const canvas = await loadCanvas('nonexistent', testDir);
      expect(canvas).toBeNull();
    });

    it('saves and loads canvas', async () => {
      await saveCanvas('ws-1', emptyCanvas, testDir);
      const loaded = await loadCanvas('ws-1', testDir);
      expect(loaded).toEqual(emptyCanvas);
    });
  });

  describe('listWorkspaceIds', () => {
    it('returns empty array when no workspaces', async () => {
      const ids = await listWorkspaceIds(testDir);
      expect(ids).toEqual([]);
    });

    it('lists workspace directories', async () => {
      await saveCanvas('ws-a', emptyCanvas, testDir);
      await saveCanvas('ws-b', emptyCanvas, testDir);
      const ids = await listWorkspaceIds(testDir);
      expect(ids.sort()).toEqual(['ws-a', 'ws-b']);
    });
  });

  describe('createWorkspace', () => {
    it('creates workspace with manifest entry', async () => {
      const result = await createWorkspace('My Workspace', testDir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ids = await listWorkspaceIds(testDir);
      expect(ids).toContain(result.data.id);

      const manifest = await loadWorkspaceManifest(testDir);
      expect(manifest.workspaces).toContainEqual({ id: result.data.id, name: 'My Workspace' });

      const canvas = await loadCanvas(result.data.id, testDir);
      expect(canvas).not.toBeNull();
      expect(canvas!.nodes).toEqual([]);
    });
  });

  describe('deleteWorkspace', () => {
    it('deletes workspace and updates manifest', async () => {
      const createResult = await createWorkspace('To Delete', testDir);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const wsId = createResult.data.id;
      const deleteResult = await deleteWorkspace(wsId, testDir);
      expect(deleteResult.ok).toBe(true);

      const ids = await listWorkspaceIds(testDir);
      expect(ids).not.toContain(wsId);

      const manifest = await loadWorkspaceManifest(testDir);
      expect(manifest.workspaces.find(e => e.id === wsId)).toBeUndefined();
    });
  });

  describe('wipe guard', () => {
    const makeNode = (id: string): CanvasNode => ({
      id,
      type: 'file',
      title: id,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: {},
    });

    it('refuses to overwrite a non-empty canvas with empty nodes by default', async () => {
      const populated: CanvasSaveData = {
        ...emptyCanvas,
        nodes: [makeNode('node-a'), makeNode('node-b')],
      };
      await saveCanvas('ws-wipe', populated, testDir);

      await expect(
        saveCanvas('ws-wipe', emptyCanvas, testDir),
      ).rejects.toBeInstanceOf(CanvasWipeRefusedError);

      // Disk must be untouched.
      const loaded = await loadCanvas('ws-wipe', testDir);
      expect(loaded?.nodes).toHaveLength(2);
    });

    it('allows an empty write when { allowEmpty: true } is passed', async () => {
      const populated: CanvasSaveData = {
        ...emptyCanvas,
        nodes: [makeNode('node-a')],
      };
      await saveCanvas('ws-wipe-ok', populated, testDir);

      await saveCanvas('ws-wipe-ok', emptyCanvas, testDir, { allowEmpty: true });

      const loaded = await loadCanvas('ws-wipe-ok', testDir);
      expect(loaded?.nodes).toEqual([]);
    });

    it('allows empty writes when no canvas exists on disk', async () => {
      // Fresh workspace: guard reads fail with ENOENT → fall through.
      await expect(
        saveCanvas('ws-fresh', emptyCanvas, testDir),
      ).resolves.toBeUndefined();
      const loaded = await loadCanvas('ws-fresh', testDir);
      expect(loaded?.nodes).toEqual([]);
    });

    it('allows empty writes when disk canvas is also empty', async () => {
      await saveCanvas('ws-empty', emptyCanvas, testDir, { allowEmpty: true });
      await expect(
        saveCanvas('ws-empty', emptyCanvas, testDir),
      ).resolves.toBeUndefined();
    });

    it('lets commitNodeMutation delete the last remaining node', async () => {
      const populated: CanvasSaveData = {
        ...emptyCanvas,
        nodes: [makeNode('node-only')],
      };
      await saveCanvas('ws-last', populated, testDir);

      const result = await commitNodeMutation(
        'ws-last',
        { removeId: 'node-only' },
        testDir,
      );
      expect(result).not.toBeNull();
      expect(result?.nodes).toEqual([]);

      const loaded = await loadCanvas('ws-last', testDir);
      expect(loaded?.nodes).toEqual([]);
    });
  });

  describe('ensureWorkspaceDir', () => {
    it('creates directory and seeds AGENTS.md', async () => {
      await ensureWorkspaceDir('ws-new', testDir);
      const dir = getWorkspaceDir('ws-new', testDir);
      const agentsMd = await fs.readFile(join(dir, 'AGENTS.md'), 'utf-8');
      expect(agentsMd).toContain('Canvas Agent Config');
    });

    it('does not overwrite existing AGENTS.md', async () => {
      await ensureWorkspaceDir('ws-existing', testDir);
      const dir = getWorkspaceDir('ws-existing', testDir);
      await fs.writeFile(join(dir, 'AGENTS.md'), 'custom content', 'utf-8');

      await ensureWorkspaceDir('ws-existing', testDir);
      const content = await fs.readFile(join(dir, 'AGENTS.md'), 'utf-8');
      expect(content).toBe('custom content');
    });
  });
});

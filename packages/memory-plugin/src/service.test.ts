import BetterSqlite3 from 'better-sqlite3';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMemoryPluginService, HashEmbeddingProvider } from './service.js';
import type { EmbeddingProvider, FileMemoryServiceOptions } from './types.js';

const createdDirs: string[] = [];

async function createService(options: FileMemoryServiceOptions = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), 'memory-plugin-test-'));
  createdDirs.push(baseDir);
  const service = new FileMemoryPluginService({
    baseDir,
    ...options,
  });
  await service.initialize();
  return { baseDir, service };
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('FileMemoryPluginService', () => {
  it('records and recalls memories with default hash embeddings', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-1',
      userText: 'Please remember: default to TypeScript and use pnpm in this repo.',
      assistantText: 'I fixed the root cause and aligned the tooling.',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-1',
      limit: 10,
    });

    expect(listed.length).toBeGreaterThan(0);

    const recall = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-1',
      query: 'what language and package manager should we use',
      limit: 5,
    });

    expect(recall.enabled).toBe(true);
    expect(recall.items.length).toBeGreaterThan(0);
    expect(recall.promptAppend).toContain('Memory context from previous conversations');
  });

  it('stops recording and recall when session is disabled', async () => {
    const { service } = await createService();

    await service.setSessionEnabled('test-platform', 'session-2', false);

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-2',
      userText: 'Remember to always run tests before merge.',
      assistantText: 'Understood.',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-2',
      limit: 10,
    });

    expect(listed).toHaveLength(0);

    const recall = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-2',
      query: 'should we run tests',
      limit: 5,
    });

    expect(recall.enabled).toBe(false);
    expect(recall.items).toHaveLength(0);
    expect(recall.promptAppend).toBeUndefined();
  });

  it('supports keyword-only recall when semantic recall is disabled', async () => {
    const { baseDir, service } = await createService({ semanticRecallEnabled: false });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-3',
      userText: 'Please remember: never use yarn in this project.',
      assistantText: 'Acknowledged.',
    });

    const recall = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-3',
      query: 'should we use yarn',
      limit: 5,
    });

    expect(recall.enabled).toBe(true);
    expect(recall.items.length).toBeGreaterThan(0);

    const vectorPath = join(baseDir, 'vectors.sqlite');
    await expect(access(vectorPath)).rejects.toThrow();
  });

  it('uses explicit embedding dimensions with a custom provider', async () => {
    class TinyEmbeddingProvider implements EmbeddingProvider {
      readonly dimensions = 128;

      async embed(): Promise<number[]> {
        return [1, 2, 3];
      }
    }

    const { baseDir, service } = await createService({
      embeddingProvider: new TinyEmbeddingProvider(),
      embeddingDimensions: 256,
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-4',
      userText: 'Remember this rule: must include tests before merge.',
      assistantText: 'Resolved.',
    });

    const db = new BetterSqlite3(join(baseDir, 'vectors.sqlite'), { readonly: true });
    const row = db.prepare('SELECT vector FROM memory_vectors LIMIT 1').get() as { vector: string } | undefined;
    db.close();

    expect(row).toBeDefined();
    const vector = JSON.parse(row!.vector) as number[];
    expect(vector.length).toBe(256);
    expect(vector.some((value) => value !== 0)).toBe(true);
  });
});

describe('HashEmbeddingProvider', () => {
  it('clamps dimensions into supported range', () => {
    const low = new HashEmbeddingProvider(1);
    const high = new HashEmbeddingProvider(99999);

    expect(low.dimensions).toBe(64);
    expect(high.dimensions).toBe(4096);
  });
});

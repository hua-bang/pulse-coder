import BetterSqlite3 from 'better-sqlite3';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.useRealTimers();
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

  it('tags explicit writes with explicit source metadata', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-explicit',
      userText: 'Remember this rule: must run lint and tests before every merge.',
      assistantText: 'Resolved by updating CI checks for lint and unit tests.',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-explicit',
      limit: 10,
    });

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.sourceType === 'explicit')).toBe(true);
    expect(listed.some((item) => item.dayKey !== undefined)).toBe(false);
    expect(listed.some((item) => item.hitCount !== undefined)).toBe(false);
  });

  it('dedupes daily-log writes on the same day and increments hit counts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T10:00:00Z'));

    const { service } = await createService({
      dailyLogPolicy: {
        enabled: true,
        mode: 'write',
        minConfidence: 0.65,
        maxPerTurn: 3,
        maxPerDay: 10,
      },
    });

    const input = {
      platformKey: 'test-platform',
      sessionId: 'session-daily-dedupe',
      userText: 'Rule: we must keep API responses backward compatible for all minor releases.',
      assistantText: 'Decision: we will adopt contract tests for release safety checks.',
      sourceType: 'daily-log' as const,
    };

    await service.recordTurn(input);
    await service.recordTurn(input);

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-daily-dedupe',
      limit: 10,
    });

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.sourceType === 'daily-log')).toBe(true);
    expect(listed.every((item) => item.dayKey === '2026-02-22')).toBe(true);
    expect(listed.every((item) => item.dedupeKey && item.dedupeKey.length > 0)).toBe(true);
    expect(listed.every((item) => item.hitCount === 2)).toBe(true);
    expect(listed.every((item) => item.firstSeenAt !== undefined)).toBe(true);
    expect(listed.every((item) => item.lastSeenAt !== undefined)).toBe(true);
  });

  it('enforces daily-log per-day quota', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T11:00:00Z'));

    const { service } = await createService({
      dailyLogPolicy: {
        enabled: true,
        mode: 'write',
        minConfidence: 0.65,
        maxPerTurn: 3,
        maxPerDay: 1,
      },
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-daily-quota',
      userText: 'Rule: must run integration tests before deploying to staging.',
      assistantText: 'Acknowledged.',
      sourceType: 'daily-log',
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-daily-quota',
      userText: 'Rule: must include migration notes for schema changes in each PR.',
      assistantText: 'Acknowledged.',
      sourceType: 'daily-log',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-daily-quota',
      limit: 10,
    });

    expect(listed).toHaveLength(1);
    expect(listed[0].sourceType).toBe('daily-log');
    expect(listed[0].content).toContain('integration tests');
  });

  it('applies daily-log quality gate for low-signal candidates', async () => {
    const { service } = await createService({
      dailyLogPolicy: {
        enabled: true,
        mode: 'write',
        minConfidence: 0.65,
        maxPerTurn: 3,
        maxPerDay: 10,
      },
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-daily-quality',
      userText: 'must test',
      assistantText: 'ok',
      sourceType: 'daily-log',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-daily-quality',
      limit: 10,
    });

    expect(listed).toHaveLength(0);
  });

  it('supports shadow mode for daily-log without persisting items', async () => {
    const { service } = await createService({
      dailyLogPolicy: {
        enabled: true,
        mode: 'shadow',
        minConfidence: 0.65,
        maxPerTurn: 3,
        maxPerDay: 10,
      },
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-daily-shadow',
      userText: 'Rule: we must keep changelog entries for every release.',
      assistantText: 'Decision: we will enforce changelog checks in CI.',
      sourceType: 'daily-log',
    });

    const afterDailyLog = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-daily-shadow',
      limit: 10,
    });

    expect(afterDailyLog).toHaveLength(0);

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-daily-shadow',
      userText: 'Remember this preference: default to pnpm in this repository.',
      assistantText: 'Acknowledged.',
      sourceType: 'explicit',
    });

    const afterExplicit = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-daily-shadow',
      limit: 10,
    });

    expect(afterExplicit.length).toBeGreaterThan(0);
    expect(afterExplicit.every((item) => item.sourceType === 'explicit')).toBe(true);
  });

  it('stores profile facts as user-scope memory across sessions', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-profile-a',
      userText: 'Profile: my name is Jasper.',
      assistantText: 'Profile captured.',
      sourceType: 'explicit',
    });

    const sessionA = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-profile-a',
      limit: 10,
    });

    const profileItem = sessionA.find((item) => item.type === 'fact' && item.scope === 'user');
    expect(profileItem).toBeDefined();
    expect(profileItem?.content.toLowerCase()).toContain('jasper');
    expect(profileItem?.sourceType).toBe('explicit');

    const sessionB = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-profile-b',
      limit: 10,
    });

    expect(sessionB.some((item) => item.id === profileItem?.id)).toBe(true);

    const recall = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-profile-b',
      query: 'what is my name',
      limit: 5,
    });

    expect(recall.items.some((item) => item.id === profileItem?.id)).toBe(true);
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

import BetterSqlite3 from 'better-sqlite3';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('writes layered files for user and daily memory storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T12:00:00Z'));

    const { baseDir, service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-layered',
      userText: 'Profile: my name is Jasper.',
      assistantText: 'Profile captured.',
      sourceType: 'explicit',
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-layered',
      userText: 'Rule: must keep changelog entries for every release.',
      assistantText: 'Decision: we will enforce release checklist in CI.',
      sourceType: 'daily-log',
    });

    const userPath = join(baseDir, 'test-platform', 'user', 'memories.json');
    const dailyPath = join(baseDir, 'test-platform', 'daily', '2026-02-22.json');

    const userRaw = JSON.parse(await readFile(userPath, 'utf-8')) as { items?: Array<{ scope: string }>; sessionEnabled?: Record<string, boolean> };
    const dailyRaw = JSON.parse(await readFile(dailyPath, 'utf-8')) as { items?: Array<{ sourceType?: string; dayKey?: string; sessionId?: string }> };

    expect(Array.isArray(userRaw.items)).toBe(true);
    expect(userRaw.items?.some((item) => item.scope === 'user')).toBe(true);
    expect(userRaw.sessionEnabled).toBeDefined();

    expect(Array.isArray(dailyRaw.items)).toBe(true);
    expect(dailyRaw.items?.every((item) => item.sourceType === 'daily-log')).toBe(true);
    expect(dailyRaw.items?.every((item) => item.dayKey === '2026-02-22')).toBe(true);
    expect(dailyRaw.items?.every((item) => item.sessionId === 'session-layered')).toBe(true);
  });

  it('migrates legacy state.json into layered layout and keeps behavior unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T09:00:00Z'));

    const baseDir = await mkdtemp(join(tmpdir(), 'memory-plugin-test-'));
    createdDirs.push(baseDir);

    const legacyState = {
      items: [
        {
          id: 'legacy-user',
          platformKey: 'legacy-platform',
          scope: 'user',
          type: 'fact',
          content: 'Profile: my name is Jasper.',
          summary: 'my name is Jasper',
          keywords: ['jasper'],
          confidence: 0.8,
          importance: 0.8,
          pinned: false,
          deleted: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastAccessedAt: Date.now(),
          sourceType: 'explicit',
        },
        {
          id: 'legacy-daily',
          platformKey: 'legacy-platform',
          sessionId: 'legacy-session',
          scope: 'session',
          type: 'rule',
          content: 'Rule: always run tests before merge.',
          summary: 'always run tests before merge',
          keywords: ['tests', 'merge'],
          confidence: 0.75,
          importance: 0.8,
          pinned: false,
          deleted: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastAccessedAt: Date.now(),
          sourceType: 'daily-log',
          dayKey: '2026-02-23',
          dedupeKey: 'rule:always run tests before merge',
          hitCount: 1,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
        },
      ],
      sessionEnabled: {
        'legacy-platform:legacy-session': false,
      },
    };

    await writeFile(join(baseDir, 'state.json'), JSON.stringify(legacyState, null, 2), 'utf-8');

    const service = new FileMemoryPluginService({ baseDir });
    await service.initialize();

    const listResult = await service.list({
      platformKey: 'legacy-platform',
      sessionId: 'legacy-session',
      limit: 20,
    });
    expect(listResult.some((item) => item.id === 'legacy-user')).toBe(true);
    expect(listResult.some((item) => item.id === 'legacy-daily')).toBe(true);

    const recallResult = await service.recall({
      platformKey: 'legacy-platform',
      sessionId: 'legacy-session',
      query: 'what is my name',
      limit: 5,
    });
    expect(recallResult.enabled).toBe(false);

    await expect(access(join(baseDir, 'state.v1.backup.json'))).resolves.toBeUndefined();
    await expect(access(join(baseDir, 'state.json'))).rejects.toThrow();

    const userRaw = JSON.parse(await readFile(join(baseDir, 'legacy-platform', 'user', 'memories.json'), 'utf-8')) as { items?: Array<{ id: string }> };
    const dailyRaw = JSON.parse(await readFile(join(baseDir, 'legacy-platform', 'daily', '2026-02-23.json'), 'utf-8')) as { items?: Array<{ id: string }> };

    expect(userRaw.items?.some((item) => item.id === 'legacy-user')).toBe(true);
    expect(dailyRaw.items?.some((item) => item.id === 'legacy-daily')).toBe(true);
  });

  it('records and recalls memories with default hash embeddings', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-1',
      userText: 'Rule: must use TypeScript and pnpm in this repo.',
      assistantText: 'Decision: we will keep CI aligned to that tooling.',
      sourceType: 'daily-log',
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
      userText: 'Rule: must never use yarn in this project.',
      assistantText: 'Acknowledged.',
      sourceType: 'daily-log',
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

  it('stores chunk metadata and source references for explicit records', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-22T08:30:00Z'));

    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-chunk-explicit',
      userText: 'Rule: must run lint before merge.\nRemember this preference: default to pnpm.',
      assistantText: 'Resolved by fixing CI lint configuration.',
      sourceType: 'explicit',
    });

    const listed = await service.list({
      platformKey: 'test-platform',
      sessionId: 'session-chunk-explicit',
      limit: 20,
    });

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.chunkId && item.chunkId.length > 0)).toBe(true);
    expect(listed.every((item) => item.sourceRef?.path === 'explicit/test-platform/session-chunk-explicit/2026-02-22.log')).toBe(true);
    expect(listed.every((item) => typeof item.sourceRef?.line === 'number' && item.sourceRef.line >= 1)).toBe(true);
    expect(listed.every((item) => typeof item.sourceRef?.offset === 'number' && item.sourceRef.offset >= 0)).toBe(true);
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
    expect(listed.every((item) => item.chunkId && item.chunkId.length > 0)).toBe(true);
    expect(listed.every((item) => item.sourceRef?.path === 'daily-log/test-platform/session-daily-dedupe/2026-02-22.log')).toBe(true);
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

  it('recall returns only daily-log memories', async () => {
    const { service } = await createService();

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-recall-filter',
      userText: 'Profile: my favorite editor is Vim.',
      assistantText: 'Profile captured.',
      sourceType: 'explicit',
    });

    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-recall-filter',
      userText: 'Rule: must run tests before merge.',
      assistantText: 'Decision: we will enforce CI checks.',
      sourceType: 'daily-log',
    });

    const recall = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-recall-filter',
      query: 'what are our merge requirements',
      limit: 5,
    });

    expect(recall.items.length).toBeGreaterThan(0);
    expect(recall.items.every((item) => item.sourceType === 'daily-log')).toBe(true);
  });

  it('supports relative day filters in recall queries', async () => {
    vi.useFakeTimers();
    const { service } = await createService();

    vi.setSystemTime(new Date('2026-02-24T09:00:00Z'));
    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-recall-time-filter',
      userText: 'Rule: keep rollback steps documented.',
      assistantText: 'Decision: keep rollback notes with every release.',
      sourceType: 'daily-log',
    });

    vi.setSystemTime(new Date('2026-02-25T09:00:00Z'));
    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-recall-time-filter',
      userText: 'Rule: track risky changes with owner names.',
      assistantText: 'Decision: enforce owner tags for risky changes.',
      sourceType: 'daily-log',
    });

    vi.setSystemTime(new Date('2026-02-26T09:00:00Z'));
    await service.recordTurn({
      platformKey: 'test-platform',
      sessionId: 'session-recall-time-filter',
      userText: 'Rule: keep migration dry-run logs.',
      assistantText: 'Decision: require dry-run logs in release checklist.',
      sourceType: 'daily-log',
    });

    vi.setSystemTime(new Date('2026-02-26T12:00:00Z'));

    const yesterday = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-recall-time-filter',
      query: '我昨天有什么决策',
      limit: 8,
    });

    expect(yesterday.items.length).toBeGreaterThan(0);
    expect(yesterday.items.every((item) => item.dayKey === '2026-02-25')).toBe(true);

    const recentTwoDays = await service.recall({
      platformKey: 'test-platform',
      sessionId: 'session-recall-time-filter',
      query: '最近2天有哪些决策',
      limit: 8,
    });

    expect(recentTwoDays.items.length).toBeGreaterThan(0);
    expect(recentTwoDays.items.every((item) => item.dayKey === '2026-02-25' || item.dayKey === '2026-02-26')).toBe(true);
    expect(recentTwoDays.items.some((item) => item.dayKey === '2026-02-24')).toBe(false);
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

    expect(recall.items).toHaveLength(0);
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
      userText: 'Rule: must include tests before merge.',
      assistantText: 'Decision: we will enforce that in CI.',
      sourceType: 'daily-log',
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


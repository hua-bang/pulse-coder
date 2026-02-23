import BetterSqlite3 from 'better-sqlite3';
import type { MemoryItem } from '../types.js';
import type { StoredEmbeddingRow } from './vector-types.js';
import { parseEmbedding } from './hash-provider.js';

export interface VectorStore {
  db?: InstanceType<typeof BetterSqlite3>;
  semanticRecallEnabled: boolean;
}

export function initializeVectorStore(
  vectorStorePath: string,
  semanticRecallEnabled: boolean,
): VectorStore {
  if (!semanticRecallEnabled) {
    return { semanticRecallEnabled, db: undefined };
  }

  try {
    const db = new BetterSqlite3(vectorStorePath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        platform_key TEXT NOT NULL,
        vector TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_platform_key ON memory_vectors(platform_key);
    `);
    return { semanticRecallEnabled: true, db };
  } catch (error) {
    console.warn('[memory-plugin] semantic recall disabled: failed to initialize vector store', error);
    return { semanticRecallEnabled: false, db: undefined };
  }
}

export function loadEmbeddings(
  store: VectorStore,
  memoryIds: string[],
  dimensions: number,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (!store.semanticRecallEnabled || !store.db || memoryIds.length === 0) {
    return result;
  }

  const stmt = store.db.prepare('SELECT vector FROM memory_vectors WHERE memory_id = ?') as {
    get: (memoryId: string) => StoredEmbeddingRow | undefined;
  };

  for (const memoryId of memoryIds) {
    const row = stmt.get(memoryId);
    if (!row) {
      continue;
    }
    const vector = parseEmbedding(row.vector, dimensions);
    if (vector) {
      result.set(memoryId, vector);
    }
  }

  return result;
}

export function upsertEmbedding(
  store: VectorStore,
  item: MemoryItem,
  embedding: number[] | undefined,
): void {
  if (!store.semanticRecallEnabled || !store.db || item.deleted || !embedding) {
    return;
  }

  const stmt = store.db.prepare(`
    INSERT INTO memory_vectors (memory_id, platform_key, vector, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      platform_key = excluded.platform_key,
      vector = excluded.vector,
      updated_at = excluded.updated_at
  `);

  stmt.run(item.id, item.platformKey, JSON.stringify(embedding), Date.now());
}

export function deleteEmbeddings(store: VectorStore, memoryIds: string[]): void {
  if (!store.semanticRecallEnabled || !store.db || memoryIds.length === 0) {
    return;
  }

  const stmt = store.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?');
  for (const memoryId of new Set(memoryIds)) {
    stmt.run(memoryId);
  }
}

export function listStoredEmbeddingIds(store: VectorStore): Set<string> | undefined {
  if (!store.semanticRecallEnabled || !store.db) {
    return new Set<string>();
  }

  try {
    const rows = store.db.prepare('SELECT memory_id FROM memory_vectors').all() as Array<{ memory_id: string }>;
    return new Set(rows.map((row) => row.memory_id));
  } catch {
    return undefined;
  }
}

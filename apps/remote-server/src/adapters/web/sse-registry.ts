/**
 * SSE connection registry with race-condition-safe buffering.
 *
 * Timeline:
 *   1. POST /api/chat  → agent starts async → createSlot() is called
 *   2. Client opens GET /api/stream/:streamId  → connectWriter() is called
 *   3. Events that arrive in step 1 before step 2 are buffered, then flushed on connect
 */

interface SSEEntry {
  writer: ((event: string, dataStr: string) => void) | null;
  buffer: Array<{ event: string; dataStr: string }>;
  closed: boolean;
}

const registry = new Map<string, SSEEntry>();

/** Called when the agent starts — reserves a slot for this streamId. */
export function createSlot(streamId: string): void {
  registry.set(streamId, { writer: null, buffer: [], closed: false });
}

/** Called by GET /api/stream/:streamId when the SSE connection opens. */
export function connectWriter(streamId: string, writer: (event: string, dataStr: string) => void): void {
  const entry = registry.get(streamId);
  if (!entry) return;

  entry.writer = writer;
  // Flush anything that arrived before the SSE connection opened
  for (const item of entry.buffer) {
    writer(item.event, item.dataStr);
  }
  entry.buffer = [];
}

/** Push an SSE event — buffers if no writer is connected yet. */
export function pushEvent(streamId: string, event: string, data: unknown): void {
  const entry = registry.get(streamId);
  if (!entry || entry.closed) return;

  const dataStr = JSON.stringify(data);
  if (entry.writer) {
    entry.writer(event, dataStr);
  } else {
    entry.buffer.push({ event, dataStr });
  }
}

/** Mark stream as finished. Cleans up the slot after 30s (gives client time to reconnect). */
export function closeSlot(streamId: string): void {
  const entry = registry.get(streamId);
  if (!entry) return;
  entry.closed = true;
  setTimeout(() => registry.delete(streamId), 30_000);
}

export function hasSlot(streamId: string): boolean {
  return registry.has(streamId);
}

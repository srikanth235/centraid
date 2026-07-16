/*
 * Platform-neutral vault-change wire types and the pure SSE frame grammar.
 * Split out of `vault-change-feed.ts` (which owns the browser-only fetch feed,
 * sessionStorage cursor and window rescoping) so the React Native change-feed
 * adapter and the coordinator can share the exact same parsing.
 */

export interface VaultChangeCursor {
  epoch: string;
  seq: number;
}

export interface VaultChangeEntry {
  cursor: VaultChangeCursor;
  entity: string;
  rowId: string;
  op: 'insert' | 'update' | 'delete';
  changedAt: string;
}

export type VaultChangeMessage =
  | { type: 'centraid:vault-change'; detail: VaultChangeEntry }
  | { type: 'centraid:vault-cursor'; cursor: VaultChangeCursor }
  | { type: 'centraid:vault-rebootstrap'; detail: unknown };

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export const INITIAL_VAULT_CURSOR: VaultChangeCursor = { epoch: '0', seq: 0 };

export function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

export function decodeFrame(raw: string): SseFrame | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}

export function parseCursor(value: unknown): VaultChangeCursor | undefined {
  if (typeof value === 'string') {
    const separator = value.lastIndexOf(':');
    if (separator <= 0) return undefined;
    const seq = Number(value.slice(separator + 1));
    if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
    return { epoch: value.slice(0, separator), seq };
  }
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { epoch?: unknown; seq?: unknown; cursor?: unknown };
  if (candidate.cursor) return parseCursor(candidate.cursor);
  if (typeof candidate.epoch !== 'string') return undefined;
  const seq = typeof candidate.seq === 'number' ? candidate.seq : Number(candidate.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: candidate.epoch, seq };
}

export function parseChange(
  value: unknown,
  fallbackCursor: VaultChangeCursor,
): VaultChangeEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const change = value as Record<string, unknown>;
  const cursor =
    parseCursor(change.cursor) ??
    parseCursor({ epoch: change.epoch, seq: change.seq }) ??
    fallbackCursor;
  const entity = change.entity;
  const rowId = change.rowId ?? change.row_id;
  const op = change.op;
  const changedAt = change.changedAt ?? change.changed_at;
  if (
    typeof entity !== 'string' ||
    typeof rowId !== 'string' ||
    (op !== 'insert' && op !== 'update' && op !== 'delete')
  ) {
    return undefined;
  }
  return {
    cursor,
    entity,
    rowId,
    op,
    changedAt: typeof changedAt === 'string' ? changedAt : new Date().toISOString(),
  };
}

/** Parse a fetch-backed SSE response, including split CRLF and multi-line data frames. */
export async function consumeVaultChangeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = frameBoundary(buffer);
        if (!boundary) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = decodeFrame(raw);
        if (frame) onFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (!signal?.aborted && buffer.trim()) {
      const frame = decodeFrame(buffer);
      if (frame) onFrame(frame);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

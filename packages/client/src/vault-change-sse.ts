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
  op: "insert" | "update" | "delete";
  changedAt: string;
}

/**
 * The projected batch a `change` frame carries (SB-payload, #922 A1). Opaque
 * here on purpose: this module is the platform-neutral frame grammar and must
 * not depend on the replica's row shapes. The coordinator narrows it, and
 * applies it only when its `from` matches the local cursor exactly.
 */
export type VaultChangeMessage =
  | { type: "centraid:vault-change"; detail: VaultChangeEntry }
  | {
      type: "centraid:vault-batch";
      batch: unknown;
      cursor: VaultChangeCursor;
    }
  | { type: "centraid:vault-cursor"; cursor: VaultChangeCursor }
  | { type: "centraid:vault-rebootstrap"; detail: unknown };

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export const INITIAL_VAULT_CURSOR: VaultChangeCursor = { epoch: "0", seq: 0 };

/**
 * Ceiling on the incomplete tail held between frame boundaries. A stream that
 * stops delivering `\n\n` — a truncating proxy, a corrupted or hostile feed —
 * would otherwise grow this string until the tab or the RN process dies.
 *
 * The largest legitimate frame is one replica change page: both stream routes
 * emit `limit ?? 1_000` doorbell entries per frame and no first-party client
 * sends `limit` (`packages/server/src/routes/replica-routes.ts`,
 * `multiplex-replica-routes.ts`). A doorbell entry is seq/commitId/entity/
 * rowId/op/changedAt plus the authorized `shapeIds` it wakes, so on the order
 * of 1 KiB serialized even where one row fans out across many shapes — under
 * 1 MiB for a full page, which is also where the gateway's own `SseStream`
 * begins dropping the connection for backpressure. 8 MiB is roughly 8x that
 * worst case: far above anything the protocol can emit, far below the memory a
 * runaway buffer reaches.
 *
 * Measured in UTF-16 code units, which never exceed a string's UTF-8 byte
 * count, so the guard trips no earlier than a byte-exact one would.
 */
export const MAX_BUFFERED_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * An SSE stream that cannot be parsed within {@link MAX_BUFFERED_FRAME_BYTES}.
 * Every consumer treats a rejected consume as a disconnect and reconnects from
 * its durable cursor, so abandoning the stream loses no changes.
 */
export class VaultChangeStreamError extends Error {
  readonly code = "VAULT_CHANGE_STREAM_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "VaultChangeStreamError";
  }
}

export function frameBoundary(
  buffer: string
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/u.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

export function decodeFrame(raw: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const rawLine of raw.split(/\r?\n/u)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}

export function parseCursor(value: unknown): VaultChangeCursor | undefined {
  if (typeof value === "string") {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) return undefined;
    const seq = Number(value.slice(separator + 1));
    if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
    return { epoch: value.slice(0, separator), seq };
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    epoch?: unknown;
    seq?: unknown;
    cursor?: unknown;
  };
  if (candidate.cursor) return parseCursor(candidate.cursor);
  if (typeof candidate.epoch !== "string") return undefined;
  const seq =
    typeof candidate.seq === "number" ? candidate.seq : Number(candidate.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: candidate.epoch, seq };
}

export function parseChange(
  value: unknown,
  fallbackCursor: VaultChangeCursor
): VaultChangeEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
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
    typeof entity !== "string" ||
    typeof rowId !== "string" ||
    (op !== "insert" && op !== "update" && op !== "delete")
  ) {
    return undefined;
  }
  return {
    cursor,
    entity,
    rowId,
    op,
    changedAt:
      typeof changedAt === "string" ? changedAt : new Date().toISOString(),
  };
}

/**
 * Parse a fetch-backed SSE response, including split CRLF and multi-line data
 * frames. Rejects with {@link VaultChangeStreamError} when the stream buffers
 * more than {@link MAX_BUFFERED_FRAME_BYTES} without a frame boundary.
 */
export async function consumeVaultChangeSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  async function readNextFrame(): Promise<void> {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (!signal?.aborted && buffer.trim()) {
        const frame = decodeFrame(buffer);
        if (frame) onFrame(frame);
      }
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = frameBoundary(buffer);
      if (!boundary) break;
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const frame = decodeFrame(raw);
      if (frame) onFrame(frame);
    }
    // Bounds the incomplete tail, not the traffic: every complete frame was
    // just drained, so whatever is left is one partial frame still arriving.
    if (buffer.length > MAX_BUFFERED_FRAME_BYTES) {
      // Cancel rather than leave the body draining into a buffer we refuse.
      abort();
      throw new VaultChangeStreamError(
        `vault change stream frame exceeds ${MAX_BUFFERED_FRAME_BYTES} buffered bytes`
      );
    }
    return await readNextFrame();
  }
  try {
    return await readNextFrame();
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

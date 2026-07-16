import { auth, authHeaders, doFetch, type GatewayAuth } from './gateway-client-core.js';

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

type Subscriber = {
  active: boolean;
  attachVersion: number;
  feed?: VaultFeed;
  listener: (message: VaultChangeMessage) => void;
};

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const INITIAL_CURSOR: VaultChangeCursor = { epoch: '0', seq: 0 };
const feeds = new Map<string, VaultFeed>();
const shapeIdsByScope = new Map<string, string[]>();
const subscribers = new Set<Subscriber>();

function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function decodeFrame(raw: string): SseFrame | undefined {
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

function scopeKey(gatewayAuth: GatewayAuth): string {
  return `${gatewayAuth.gatewayId ?? gatewayAuth.baseUrl}\u0000${gatewayAuth.vaultId ?? '<default>'}`;
}

function cursorStorageKey(key: string): string {
  return `centraid:vault-change-cursor:${encodeURIComponent(key)}`;
}

function parseCursor(value: unknown): VaultChangeCursor | undefined {
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

function readStoredCursor(key: string): VaultChangeCursor {
  try {
    const stored = window.sessionStorage.getItem(cursorStorageKey(key));
    if (stored) return parseCursor(JSON.parse(stored)) ?? INITIAL_CURSOR;
  } catch {
    /* Session storage is optional in hardened/browser-private contexts. */
  }
  return INITIAL_CURSOR;
}

function storeCursor(key: string, cursor: VaultChangeCursor): void {
  try {
    window.sessionStorage.setItem(cursorStorageKey(key), JSON.stringify(cursor));
  } catch {
    /* The in-memory cursor still keeps this stream resumable until teardown. */
  }
}

/** Remove a revoked scope's resumable cursor along with its replica storage. */
export function clearVaultChangeCursor(gatewayAuth: GatewayAuth): void {
  const key = scopeKey(gatewayAuth);
  feeds.get(key)?.close();
  feeds.delete(key);
  shapeIdsByScope.delete(key);
  try {
    window.sessionStorage.removeItem(cursorStorageKey(key));
  } catch {
    /* Session storage is optional in hardened/browser-private contexts. */
  }
}

function normalizeShapeIds(shapeIds: readonly string[]): string[] {
  return [...new Set(shapeIds.filter((shapeId) => shapeId.length > 0))].sort();
}

function sameShapeIds(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((shapeId, index) => shapeId === right[index]))
  );
}

function changeStreamPath(
  cursor: VaultChangeCursor,
  shapeIds: readonly string[] | undefined,
): string {
  const params = new URLSearchParams({ since: `${cursor.epoch}:${cursor.seq}`, stream: '1' });
  // Presence is significant: `shapeIds=` attests a persisted empty catalog.
  if (shapeIds) params.set('shapeIds', shapeIds.join(','));
  return `/centraid/_vault/changes?${params}`;
}

function parseChange(
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

class VaultFeed {
  readonly listeners = new Set<(message: VaultChangeMessage) => void>();
  private abortController?: AbortController;
  private cursor: VaultChangeCursor;
  private reconnectDelay = MIN_RECONNECT_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private rebootstrapRequired = false;
  private stopped = false;
  /** Invalidates late responses/frames from an aborted scope or catalog generation. */
  private generation = 0;

  constructor(
    readonly key: string,
    private readonly gatewayAuth: GatewayAuth,
    private shapeIds: string[] | undefined,
  ) {
    this.cursor = readStoredCursor(key);
  }

  add(listener: (message: VaultChangeMessage) => void): void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.connect();
  }

  remove(listener: (message: VaultChangeMessage) => void): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.stop();
  }

  /** Permanently tear down a revoked scope, even while subscribers still exist. */
  close(): void {
    this.listeners.clear();
    this.stop();
  }

  resume(cursor: VaultChangeCursor): void {
    this.generation += 1;
    this.cursor = cursor;
    storeCursor(this.key, cursor);
    this.rebootstrapRequired = false;
    this.reconnectDelay = MIN_RECONNECT_MS;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.listeners.size > 0) this.connect();
  }

  setShapeIds(shapeIds: readonly string[] | undefined): void {
    const next = shapeIds === undefined ? undefined : normalizeShapeIds(shapeIds);
    if (sameShapeIds(this.shapeIds, next)) return;
    this.generation += 1;
    this.shapeIds = next;
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.listeners.size > 0) this.connect();
  }

  private emit(message: VaultChangeMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* A broken frame must not starve the other managed app frames. */
      }
    }
  }

  private acceptCursor(cursor: VaultChangeCursor): void {
    if (cursor.epoch === this.cursor.epoch && cursor.seq < this.cursor.seq) return;
    this.cursor = cursor;
    storeCursor(this.key, cursor);
  }

  private handleFrame(frame: SseFrame): void {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (frame.event === 'rebootstrap') {
      this.rebootstrapRequired = true;
      this.emit({ type: 'centraid:vault-rebootstrap', detail: payload });
      this.abortController?.abort();
      return;
    }
    if (frame.event === 'cursor') {
      const cursor = parseCursor(payload);
      if (!cursor) return;
      this.acceptCursor(cursor);
      this.emit({ type: 'centraid:vault-cursor', cursor });
      return;
    }
    if (frame.event !== 'change' && frame.event !== 'message') return;
    const page = payload as
      | { changes?: unknown; cursor?: unknown; next?: unknown; watermark?: unknown }
      | undefined;
    const pageCursor = parseCursor(page?.cursor ?? page?.next ?? page?.watermark);
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(page?.changes)
        ? page.changes
        : [payload];
    for (const value of values) {
      const change = parseChange(value, pageCursor ?? this.cursor);
      if (!change) continue;
      this.acceptCursor(change.cursor);
      this.emit({ type: 'centraid:vault-change', detail: change });
    }
    if (pageCursor) this.acceptCursor(pageCursor);
  }

  private connect(): void {
    if (
      this.stopped ||
      this.rebootstrapRequired ||
      this.listeners.size === 0 ||
      this.abortController
    ) {
      return;
    }
    const controller = new AbortController();
    const generation = ++this.generation;
    this.abortController = controller;
    const path = changeStreamPath(this.cursor, this.shapeIds);
    void doFetch(this.gatewayAuth.baseUrl, path, {
      method: 'GET',
      headers: { ...authHeaders(this.gatewayAuth.token), Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!this.isCurrent(controller, generation)) return;
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 409 ||
          response.status === 410
        ) {
          let detail: unknown = {
            code:
              response.status === 401 || response.status === 403
                ? 'replica_device_not_enrolled'
                : 'rebootstrap_required',
            status: response.status,
          };
          try {
            detail = await response.json();
          } catch {
            /* Keep the typed fallback detail when the body is empty/malformed. */
          }
          if (!this.isCurrent(controller, generation)) return;
          this.rebootstrapRequired = true;
          this.emit({ type: 'centraid:vault-rebootstrap', detail });
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`vault change stream failed (HTTP ${response.status})`);
        }
        this.reconnectDelay = MIN_RECONNECT_MS;
        await consumeVaultChangeSse(
          response.body,
          (frame) => {
            if (this.isCurrent(controller, generation)) this.handleFrame(frame);
          },
          controller.signal,
        );
      })
      .catch(() => {
        /* Reconnect below; individual app frames remain mounted and subscribed. */
      })
      .finally(() => {
        if (this.abortController === controller) this.abortController = undefined;
        if (generation === this.generation && !controller.signal.aborted) this.scheduleReconnect();
      });
  }

  private isCurrent(controller: AbortController, generation: number): boolean {
    return (
      !controller.signal.aborted &&
      generation === this.generation &&
      this.abortController === controller
    );
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.rebootstrapRequired ||
      this.listeners.size === 0 ||
      this.reconnectTimer
    ) {
      return;
    }
    const wait = Math.round(this.reconnectDelay * (0.5 + Math.random()));
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, wait);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    feeds.delete(this.key);
  }
}

function feedFor(gatewayAuth: GatewayAuth): VaultFeed {
  const key = scopeKey(gatewayAuth);
  let feed = feeds.get(key);
  if (!feed) {
    feed = new VaultFeed(key, gatewayAuth, shapeIdsByScope.get(key));
    feeds.set(key, feed);
  }
  return feed;
}

async function attach(subscriber: Subscriber): Promise<void> {
  const version = ++subscriber.attachVersion;
  try {
    const gatewayAuth = await auth();
    if (!subscriber.active || version !== subscriber.attachVersion) return;
    const feed = feedFor(gatewayAuth);
    subscriber.feed = feed;
    feed.add(subscriber.listener);
  } catch {
    /* App URL resolution shows the gateway error; the feed retries on the next scope event. */
  }
}

function detach(subscriber: Subscriber): void {
  subscriber.attachVersion++;
  subscriber.feed?.remove(subscriber.listener);
  subscriber.feed = undefined;
}

function rescopeSubscribers(): void {
  for (const subscriber of subscribers) {
    detach(subscriber);
    void attach(subscriber);
  }
}

/** Subscribe a shell consumer; every consumer in one gateway/vault shares one HTTP stream. */
export function subscribeVaultChanges(listener: (message: VaultChangeMessage) => void): () => void {
  const subscriber: Subscriber = { active: true, attachVersion: 0, listener };
  subscribers.add(subscriber);
  void attach(subscriber);
  return () => {
    if (!subscriber.active) return;
    subscriber.active = false;
    subscribers.delete(subscriber);
    detach(subscriber);
  };
}

/** Resume a feed after bootstrap commits its stable snapshot cursor. */
export async function resumeVaultChanges(cursor: VaultChangeCursor): Promise<void> {
  const gatewayAuth = await auth();
  const key = scopeKey(gatewayAuth);
  storeCursor(key, cursor);
  feeds.get(key)?.resume(cursor);
}

/**
 * Attest the catalog persisted for the active gateway/vault on every SSE reconnect.
 * `undefined` means no local catalog is available yet; `[]` attests an empty catalog.
 */
export async function setVaultChangeShapeIds(shapeIds?: readonly string[]): Promise<void> {
  const gatewayAuth = await auth();
  const key = scopeKey(gatewayAuth);
  if (shapeIds === undefined) shapeIdsByScope.delete(key);
  else shapeIdsByScope.set(key, normalizeShapeIds(shapeIds));
  feeds.get(key)?.setShapeIds(shapeIds);
}

// Scope switches keep mounted AppFrame components alive. Re-bind their
// subscriptions so the old vault/gateway stream is closed and the new scope
// gets exactly one stream as well. gateway-client-core registered its auth
// cache reset handlers before these listeners because it is imported above.
window.CentraidApi.onGatewayChanged?.(rescopeSubscribers);
window.CentraidApi.onVaultChanged?.(rescopeSubscribers);

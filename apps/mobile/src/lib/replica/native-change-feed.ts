import { fetch as expoFetch } from 'expo/fetch';

import {
  authHeaders,
  consumeVaultChangeSse,
  decodeFrame,
  INITIAL_VAULT_CURSOR,
  parseChange,
  parseCursor,
  type GatewayAuth,
  type ReplicaChangeFeedAdapter,
  type ReplicaCursor,
  type SseFrame,
  type VaultChangeCursor,
  type VaultChangeMessage,
} from '@centraid/client/replica/native';

/** The subset of `@react-native-async-storage/async-storage` the cursor uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type StreamFetch = typeof expoFetch;

export interface NativeVaultChangeFeedOptions {
  gatewayAuth: GatewayAuth;
  storage: AsyncStorageLike;
  /** Injectable streaming fetch (defaults to `expo/fetch`, which streams bodies). */
  streamFetch?: StreamFetch;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

/**
 * Single-process React Native change feed. Mirrors the browser vault feed's SSE
 * grammar (via the shared `consumeVaultChangeSse`/`decodeFrame`) but is driven by
 * `expo/fetch` (whose response bodies stream, unlike React Native's built-in
 * fetch), persists its resume cursor in AsyncStorage instead of sessionStorage,
 * and is paused/resumed explicitly by the session on AppState transitions.
 */
export class NativeVaultChangeFeed implements ReplicaChangeFeedAdapter {
  readonly #gatewayAuth: GatewayAuth;
  readonly #storage: AsyncStorageLike;
  readonly #streamFetch: StreamFetch;
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #storageKey: string;

  #listener: ((message: VaultChangeMessage) => void) | undefined;
  #shapeIds: string[] | undefined;
  #cursor: VaultChangeCursor = INITIAL_VAULT_CURSOR;
  #cursorLoaded = false;
  #active = false;
  #abort: AbortController | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectDelay = MIN_RECONNECT_MS;
  #rebootstrapRequired = false;
  #generation = 0;

  constructor(options: NativeVaultChangeFeedOptions) {
    this.#gatewayAuth = options.gatewayAuth;
    this.#storage = options.storage;
    this.#streamFetch = options.streamFetch ?? expoFetch;
    this.#minReconnectMs = options.minReconnectMs ?? MIN_RECONNECT_MS;
    this.#maxReconnectMs = options.maxReconnectMs ?? MAX_RECONNECT_MS;
    this.#storageKey = `centraid:vault-change-cursor:${encodeURIComponent(
      `${this.#gatewayAuth.gatewayId ?? this.#gatewayAuth.baseUrl} ${this.#gatewayAuth.vaultId ?? '<default>'}`,
    )}`;
  }

  subscribe(listener: (message: VaultChangeMessage) => void): () => void {
    this.#listener = listener;
    if (this.#active) this.connect();
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
      this.stopStream();
    };
  }

  async setShapeIds(shapeIds: readonly string[]): Promise<void> {
    this.#shapeIds = [...new Set(shapeIds.filter((id) => id.length > 0))].sort();
    this.reconnect();
  }

  async resume(cursor: ReplicaCursor): Promise<void> {
    this.#cursor = { epoch: cursor.epoch, seq: cursor.seq };
    this.#cursorLoaded = true;
    this.#rebootstrapRequired = false;
    await this.persistCursor(this.#cursor);
    this.reconnect();
  }

  /** Session lifecycle: open the stream on foreground, drop it on background. */
  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    if (active) this.connect();
    else this.stopStream();
  }

  private reconnect(): void {
    if (!this.#active) return;
    this.stopStream();
    this.connect();
  }

  private connect(): void {
    if (!this.#active || !this.#listener || this.#abort || this.#rebootstrapRequired) return;
    void this.run();
  }

  private async run(): Promise<void> {
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    try {
      if (!this.#cursorLoaded) {
        this.#cursor = await this.loadCursor();
        this.#cursorLoaded = true;
      }
      const response = await this.#streamFetch(this.streamUrl(this.#cursor), {
        method: 'GET',
        headers: { ...authHeaders(this.#gatewayAuth.token), Accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (!this.isCurrent(abort, generation)) return;
      if (response.status === 401 || response.status === 403) {
        this.emit({ type: 'centraid:vault-rebootstrap', detail: { status: response.status } });
        this.#rebootstrapRequired = true;
        return;
      }
      if (response.status === 409 || response.status === 410) {
        this.emit({ type: 'centraid:vault-rebootstrap', detail: { status: response.status } });
        this.#rebootstrapRequired = true;
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`vault change stream failed (HTTP ${response.status})`);
      }
      this.#reconnectDelay = this.#minReconnectMs;
      await consumeVaultChangeSse(
        response.body,
        (frame) => {
          if (this.isCurrent(abort, generation)) this.handleFrame(frame);
        },
        abort.signal,
      );
    } catch {
      /* Reconnect below unless the session paused or a newer generation started. */
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      if (generation === this.#generation && !abort.signal.aborted) this.scheduleReconnect();
    }
  }

  private handleFrame(frame: SseFrame): void {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (frame.event === 'rebootstrap') {
      this.#rebootstrapRequired = true;
      this.emit({ type: 'centraid:vault-rebootstrap', detail: payload });
      this.#abort?.abort();
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
    const page = payload as { changes?: unknown; cursor?: unknown; next?: unknown } | undefined;
    const pageCursor = parseCursor(page?.cursor ?? page?.next);
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(page?.changes)
        ? page.changes
        : [payload];
    for (const value of values) {
      const change = parseChange(value, pageCursor ?? this.#cursor);
      if (!change) continue;
      this.acceptCursor(change.cursor);
      this.emit({ type: 'centraid:vault-change', detail: change });
    }
    if (pageCursor) this.acceptCursor(pageCursor);
  }

  private acceptCursor(cursor: VaultChangeCursor): void {
    if (cursor.epoch === this.#cursor.epoch && cursor.seq < this.#cursor.seq) return;
    this.#cursor = cursor;
    void this.persistCursor(cursor);
  }

  private emit(message: VaultChangeMessage): void {
    try {
      this.#listener?.(message);
    } catch {
      /* A listener fault must not stall the stream. */
    }
  }

  private streamUrl(cursor: VaultChangeCursor): string {
    const params = new URLSearchParams({ since: `${cursor.epoch}:${cursor.seq}`, stream: '1' });
    // Presence is significant: `shapeIds=` attests a persisted empty catalog.
    if (this.#shapeIds) params.set('shapeIds', this.#shapeIds.join(','));
    return `${this.#gatewayAuth.baseUrl}/centraid/_vault/changes?${params}`;
  }

  private scheduleReconnect(): void {
    if (!this.#active || !this.#listener || this.#rebootstrapRequired || this.#reconnectTimer) {
      return;
    }
    const wait = Math.round(this.#reconnectDelay * (0.5 + Math.random()));
    this.#reconnectDelay = Math.min(this.#maxReconnectMs, this.#reconnectDelay * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, wait);
  }

  private stopStream(): void {
    this.#generation += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#reconnectDelay = this.#minReconnectMs;
  }

  private isCurrent(abort: AbortController, generation: number): boolean {
    return !abort.signal.aborted && generation === this.#generation && this.#abort === abort;
  }

  private async loadCursor(): Promise<VaultChangeCursor> {
    try {
      const stored = await this.#storage.getItem(this.#storageKey);
      if (stored) return parseCursor(JSON.parse(stored) as unknown) ?? INITIAL_VAULT_CURSOR;
    } catch {
      /* A missing/corrupt cursor just restarts the stream from the beginning. */
    }
    return INITIAL_VAULT_CURSOR;
  }

  private async persistCursor(cursor: VaultChangeCursor): Promise<void> {
    try {
      await this.#storage.setItem(this.#storageKey, JSON.stringify(cursor));
    } catch {
      /* The in-memory cursor keeps the stream resumable until process exit. */
    }
  }

  /** Drop a revoked scope's persisted resume cursor. */
  async clearCursor(): Promise<void> {
    try {
      await this.#storage.removeItem(this.#storageKey);
    } catch {
      /* Best-effort; the durable replica database is purged separately. */
    }
  }
}

/** Re-export so callers can build the pure decoder in tests without deep imports. */
export { decodeFrame };

import { fetch as expoFetch } from "expo/fetch";

import {
  authHeaders,
  consumeVaultChangeSse,
  INITIAL_VAULT_CURSOR,
  parseChange,
  parseCursor,
} from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  SseFrame,
  VaultChangeCursor,
  VaultChangeMessage,
} from "@centraid/client/replica/native";

import type { AsyncStorageLike, StreamFetch } from "./native-change-feed";
import type { NativeChangeFeed } from "./native-session";

interface ScopeState {
  vaultId: string;
  cursor: VaultChangeCursor;
  cursorLoaded: boolean;
  shapeIds?: string[];
  listener?: (message: VaultChangeMessage) => void;
  active: boolean;
  rebootstrapRequired: boolean;
}

interface ScopeFrame {
  vaultId: string;
  event: "change" | "cursor" | "rebootstrap" | "revoked";
  data: unknown;
}

export interface NativeMultiplexChangeFeedOptions {
  gatewayAuth: GatewayAuth;
  storage: AsyncStorageLike;
  streamFetch?: StreamFetch;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  onScopeRevoked?: (vaultId: string) => void;
  onScopeUpdated?: (vaultId: string) => void;
}

/**
 * Radio owner for all mounted replica sessions. `scope(vaultId)` returns the
 * ordinary feed adapter a `NativeReplicaSession` expects; the adapters share
 * this one stream and keep independent durable cursors.
 */
export class NativeMultiplexChangeFeed {
  readonly #gatewayAuth: GatewayAuth;
  readonly #storage: AsyncStorageLike;
  readonly #streamFetch: StreamFetch;
  readonly #states = new Map<string, ScopeState>();
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #onScopeRevoked: ((vaultId: string) => void) | undefined;
  readonly #onScopeUpdated: ((vaultId: string) => void) | undefined;
  #abort: AbortController | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectDelay: number;
  #generation = 0;

  constructor(options: NativeMultiplexChangeFeedOptions) {
    this.#gatewayAuth = options.gatewayAuth;
    this.#storage = options.storage;
    this.#streamFetch = options.streamFetch ?? expoFetch;
    this.#minReconnectMs = options.minReconnectMs ?? 1_000;
    this.#maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.#reconnectDelay = this.#minReconnectMs;
    this.#onScopeRevoked = options.onScopeRevoked;
    this.#onScopeUpdated = options.onScopeUpdated;
  }

  scope(vaultId: string): NativeChangeFeed {
    const state =
      this.#states.get(vaultId) ??
      ({
        vaultId,
        cursor: INITIAL_VAULT_CURSOR,
        cursorLoaded: false,
        active: false,
        rebootstrapRequired: false,
      } satisfies ScopeState);
    this.#states.set(vaultId, state);
    return {
      subscribe: (listener) => {
        state.listener = listener;
        this.reconnect();
        return () => {
          if (state.listener === listener) state.listener = undefined;
          this.reconnect();
        };
      },
      setShapeIds: async (shapeIds) => {
        state.shapeIds = [...new Set(shapeIds)].sort();
        this.reconnect();
      },
      resume: async (cursor) => {
        state.cursor = { ...cursor };
        state.cursorLoaded = true;
        state.rebootstrapRequired = false;
        await this.persist(state);
        this.reconnect();
      },
      setActive: (active) => {
        state.active = active;
        this.reconnect();
      },
    };
  }

  updateGatewayBase(baseUrl: string): void {
    if (this.#gatewayAuth.baseUrl === baseUrl) return;
    this.#gatewayAuth.baseUrl = baseUrl;
    this.reconnect();
  }

  close(): void {
    this.stop();
    this.#states.clear();
  }

  private reconnect(): void {
    this.stop();
    if (this.activeStates().length > 0) void this.run();
  }

  private stop(): void {
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  private async run(): Promise<void> {
    const states = this.activeStates();
    if (states.length === 0 || this.#abort) return;
    await Promise.all(states.map((state) => this.load(state)));
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const response = await this.#streamFetch(this.streamUrl(states), {
        method: "GET",
        headers: {
          ...authHeaders(this.#gatewayAuth.token),
          Accept: "text/event-stream",
        },
        signal: abort.signal,
      });
      if (!this.current(abort, generation)) return;
      if (!response.ok || !response.body)
        throw new Error(`multiplex replica stream failed (${response.status})`);
      this.#reconnectDelay = this.#minReconnectMs;
      await consumeVaultChangeSse(
        response.body,
        (frame) => this.handleFrame(frame),
        abort.signal
      );
    } catch {
      // Connectivity and gateway-sleep state is reported by ReplicaProvider.
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
      if (generation === this.#generation && !abort.signal.aborted)
        this.scheduleReconnect();
    }
  }

  private handleFrame(frame: SseFrame): void {
    if (frame.event !== "scope") return;
    let scopeFrame: ScopeFrame;
    try {
      scopeFrame = JSON.parse(frame.data) as ScopeFrame;
    } catch {
      return;
    }
    const state = this.#states.get(scopeFrame.vaultId);
    if (!state) return;
    if (scopeFrame.event === "revoked") {
      state.rebootstrapRequired = true;
      void this.#storage.removeItem(this.storageKey(state.vaultId));
      this.#onScopeRevoked?.(state.vaultId);
      this.reconnect();
      return;
    }
    if (scopeFrame.event === "rebootstrap") {
      state.rebootstrapRequired = true;
      state.listener?.({
        type: "centraid:vault-rebootstrap",
        detail: scopeFrame.data,
      });
      return;
    }
    if (scopeFrame.event === "cursor") {
      const cursor = parseCursor(scopeFrame.data);
      if (!cursor) return;
      this.acceptCursor(state, cursor);
      state.listener?.({ type: "centraid:vault-cursor", cursor });
      return;
    }
    const page = scopeFrame.data as
      | { changes?: unknown; cursor?: unknown }
      | undefined;
    const pageCursor = parseCursor(page?.cursor);
    const values = Array.isArray(page?.changes) ? page.changes : [];
    for (const value of values) {
      const change = parseChange(value, pageCursor ?? state.cursor);
      if (!change) continue;
      this.acceptCursor(state, change.cursor);
      state.listener?.({ type: "centraid:vault-change", detail: change });
    }
    if (pageCursor) this.acceptCursor(state, pageCursor);
  }

  private acceptCursor(state: ScopeState, cursor: VaultChangeCursor): void {
    if (cursor.epoch === state.cursor.epoch && cursor.seq < state.cursor.seq)
      return;
    state.cursor = cursor;
    this.#onScopeUpdated?.(state.vaultId);
    void this.persist(state);
  }

  private activeStates(): ScopeState[] {
    return [...this.#states.values()].filter(
      (state) => state.active && state.listener && !state.rebootstrapRequired
    );
  }

  private streamUrl(states: readonly ScopeState[]): string {
    const mounts = states.map((state) => ({
      vaultId: state.vaultId,
      cursor: state.cursor,
      ...(state.shapeIds ? { shapeIds: state.shapeIds } : {}),
    }));
    const params = new URLSearchParams({ mounts: JSON.stringify(mounts) });
    return `${this.#gatewayAuth.baseUrl}/centraid/_gateway/replica/changes?${params}`;
  }

  private scheduleReconnect(): void {
    if (this.activeStates().length === 0 || this.#reconnectTimer) return;
    const wait = Math.round(this.#reconnectDelay * (0.5 + Math.random()));
    this.#reconnectDelay = Math.min(
      this.#maxReconnectMs,
      this.#reconnectDelay * 2
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.run();
    }, wait);
  }

  private current(abort: AbortController, generation: number): boolean {
    return (
      !abort.signal.aborted &&
      generation === this.#generation &&
      this.#abort === abort
    );
  }

  private async load(state: ScopeState): Promise<void> {
    if (state.cursorLoaded) return;
    state.cursorLoaded = true;
    try {
      const raw = await this.#storage.getItem(this.storageKey(state.vaultId));
      const parsed = raw ? parseCursor(JSON.parse(raw) as unknown) : undefined;
      if (parsed) state.cursor = parsed;
    } catch {
      state.cursor = INITIAL_VAULT_CURSOR;
    }
  }

  private persist(state: ScopeState): Promise<void> {
    return this.#storage
      .setItem(this.storageKey(state.vaultId), JSON.stringify(state.cursor))
      .catch(() => undefined);
  }

  private storageKey(vaultId: string): string {
    return `centraid:multiplex-cursor:${encodeURIComponent(
      `${this.#gatewayAuth.gatewayId ?? this.#gatewayAuth.baseUrl} ${vaultId}`
    )}`;
  }
}

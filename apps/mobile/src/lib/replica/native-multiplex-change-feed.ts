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

import { fetchWithinReplyDeadline } from "./gateway-deadline";
import type { StreamFetch } from "./native-change-feed";
import type { NativeChangeFeed } from "./native-session";

interface ScopeState {
  vaultId: string;
  cursor: VaultChangeCursor;
  cursorLoaded: boolean;
  shapeIds?: string[];
  listener?: (message: VaultChangeMessage) => void;
  active: boolean;
  rebootstrapRequired: boolean;
  /**
   * A rebootstrap verdict is the ONE thing that may move this scope onto an
   * epoch it did not ask for (#1014, C19). Held apart from
   * `rebootstrapRequired`, which the feed also sets on a revoke.
   */
  epochChangeExpected: boolean;
}

interface ScopeFrame {
  vaultId: string;
  event: "change" | "cursor" | "rebootstrap" | "revoked";
  data: unknown;
}

export interface NativeMultiplexChangeFeedOptions {
  gatewayAuth: GatewayAuth;
  streamFetch?: StreamFetch;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  onScopeRevoked?: (vaultId: string) => void;
  onScopeUpdated?: (vaultId: string) => void;
  onStreamOutcome?: (reachable: boolean) => void;
  /** This mount's only resume cursor. See {@link SeatResumePosition}. */
  resumeFrom?: SeatResumePosition;
}

/**
 * WHERE A SCOPE RESUMES FROM: THE SEAT'S APPLIED POSITION (#1014, C18).
 *
 * The feed used to keep its own durable cursor, keyed by
 * `gatewayId ?? baseUrl` — a value `updateGatewayBase` mutates mid-session,
 * so every launch orphaned a key and the gateway was sent a position nothing
 * reconciled with `applied_seq`. There is one cursor on this phone and it is
 * the seat's (`native-session.ts`'s opening comment says so); this is the
 * shape it is read in, so the feed never holds a second copy of it.
 *
 * `undefined` — no seat yet, or no copy — starts at the initial cursor, which
 * costs a replay of wake FRAMES and nothing else: a frame is a wake, not a
 * delivery, and the catch-up behind it is idempotent.
 */
export type SeatResumePosition = () =>
  | { readonly epoch: string; readonly applied: number }
  | undefined;

/**
 * Radio owner for all mounted replica sessions. `scope(vaultId)` returns the
 * ordinary feed adapter a `NativeReplicaSession` expects; the adapters share
 * this one stream and keep independent durable cursors.
 */
export class NativeMultiplexChangeFeed {
  readonly #gatewayAuth: GatewayAuth;
  readonly #streamFetch: StreamFetch;
  readonly #states = new Map<string, ScopeState>();
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #onScopeRevoked: ((vaultId: string) => void) | undefined;
  readonly #onScopeUpdated: ((vaultId: string) => void) | undefined;
  readonly #onStreamOutcome: ((reachable: boolean) => void) | undefined;
  readonly #resumeFrom: SeatResumePosition | undefined;

  #abort: AbortController | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectDelay: number;
  #generation = 0;

  constructor(options: NativeMultiplexChangeFeedOptions) {
    this.#gatewayAuth = options.gatewayAuth;
    this.#streamFetch = options.streamFetch ?? expoFetch;
    this.#minReconnectMs = options.minReconnectMs ?? 1_000;
    this.#maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.#reconnectDelay = this.#minReconnectMs;
    this.#onScopeRevoked = options.onScopeRevoked;
    this.#onScopeUpdated = options.onScopeUpdated;
    this.#onStreamOutcome = options.onStreamOutcome;
    this.#resumeFrom = options.resumeFrom;
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
        epochChangeExpected: false,
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
      resume: (cursor) => {
        state.cursor = { ...cursor };
        state.cursorLoaded = true;
        state.rebootstrapRequired = false;
        state.epochChangeExpected = false;
        this.reconnect();
        return Promise.resolve();
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
    // NOTHING TO LAND (#1014, C18). The resume position lives in the seat's
    // `seat_state`, written in the applier's own transaction; this feed keeps
    // no durable state of its own that a kill could lose.
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
    for (const state of states) this.load(state);
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const response = await fetchWithinReplyDeadline(
        (signal) =>
          this.#streamFetch(this.streamUrl(states), {
            method: "GET",
            headers: {
              ...authHeaders(this.#gatewayAuth.token),
              Accept: "text/event-stream",
            },
            signal,
          }) as Promise<Response>,
        abort.signal
      );
      if (!this.current(abort, generation)) return;
      if (!response.ok || !response.body)
        throw new Error(`multiplex replica stream failed (${response.status})`);
      this.#reconnectDelay = this.#minReconnectMs;
      this.#onStreamOutcome?.(true);
      await consumeVaultChangeSse(
        response.body,
        (frame) => this.handleFrame(frame),
        abort.signal
      );
    } catch {
      // Swallowing this hid a dead vault (docs/traps/unreachable-vault.md).
      if (!abort.signal.aborted) this.#onStreamOutcome?.(false);
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
      this.#onScopeRevoked?.(state.vaultId);
      this.reconnect();
      return;
    }
    if (scopeFrame.event === "rebootstrap") {
      state.rebootstrapRequired = true;
      // The one verdict that licenses an epoch change (#1014, C19).
      state.epochChangeExpected = true;
      state.listener?.({
        type: "centraid:vault-rebootstrap",
        detail: scopeFrame.data,
      });
      return;
    }
    if (scopeFrame.event === "cursor") {
      const cursor = parseCursor(scopeFrame.data);
      if (!cursor) return;
      if (this.advanceCursor(state, cursor)) this.settleFrame(state);
      state.listener?.({ type: "centraid:vault-cursor", cursor });
      return;
    }
    const page = scopeFrame.data as
      | { changes?: unknown; cursor?: unknown }
      | undefined;
    const pageCursor = parseCursor(page?.cursor);
    const values = Array.isArray(page?.changes) ? page.changes : [];
    // ONE frame, ONE settle. Advancing the in-memory cursor is free; the disk
    // write and the freshness callback behind it are not, and a page of a
    // thousand changes has exactly one newest cursor to report.
    let advanced = false;
    for (const value of values) {
      const change = parseChange(value, pageCursor ?? state.cursor);
      if (!change) continue;
      advanced = this.advanceCursor(state, change.cursor) || advanced;
      state.listener?.({ type: "centraid:vault-change", detail: change });
    }
    if (pageCursor)
      advanced = this.advanceCursor(state, pageCursor) || advanced;
    if (advanced) this.settleFrame(state);
  }

  /**
   * In-memory only: returns whether the cursor actually moved forward.
   *
   * AN EPOCH IT DID NOT ASK FOR IS IGNORED (#1014, C19). This accepted any
   * cursor whose epoch merely DIFFERED — so one stray frame moved the scope
   * onto another epoch, and every later frame of the real one was then read
   * as "different epoch" and taken too. An epoch change is legitimate exactly
   * twice: before this scope has a position at all, and after the gateway has
   * said `rebootstrap`. Everywhere else it is a frame for a stream this mount
   * is not on.
   */
  private advanceCursor(state: ScopeState, cursor: VaultChangeCursor): boolean {
    if (cursor.epoch !== state.cursor.epoch) {
      if (
        !state.epochChangeExpected &&
        state.cursor.epoch !== INITIAL_VAULT_CURSOR.epoch
      )
        return false;
      state.epochChangeExpected = false;
      state.cursor = cursor;
      return true;
    }
    if (cursor.seq < state.cursor.seq) return false;
    state.cursor = cursor;
    return true;
  }

  /** The per-frame cost: one freshness signal. The cursor is the seat's. */
  private settleFrame(state: ScopeState): void {
    this.#onScopeUpdated?.(state.vaultId);
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

  /**
   * Where this scope resumes: the SEAT's applied position, asked for fresh on
   * every connect (#1014, C18). Not cached, because the seat moves underneath
   * — a catch-up between two reconnects is exactly the case a stale copy
   * would send the gateway backwards for.
   */
  private load(state: ScopeState): void {
    const seat = this.#resumeFrom?.();
    if (seat) state.cursor = { epoch: seat.epoch, seq: seat.applied };
    else if (!state.cursorLoaded) state.cursor = INITIAL_VAULT_CURSOR;
    state.cursorLoaded = true;
  }
}

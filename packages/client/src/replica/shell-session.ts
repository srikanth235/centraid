/*
 * THE BROWSER'S SEAT SESSION (#996, W5).
 *
 * One scope — one (gateway, vault) — and everything that scope owns: the seat
 * file, the queue of writes waiting to reach the gateway, and the invalidations
 * that tell a screen to re-read.
 *
 * WHAT THIS REPLACED. Until W5 the session sat on top of a `ReplicaCoordinator`
 * over a SHAPED store: a projection of the vault into `replica_row` blobs, a
 * declarative read grammar compiled against it, a windowed bootstrap that
 * walked shapes page by page, and an outbox in IndexedDB beside it. All of it
 * is gone. A seat holds `vault.db` WHOLE, so a read is SQL, a bootstrap is a
 * file copy, and the queue lives in the same file as the rows it is about.
 *
 * WHICH COLLAPSES THREE THINGS INTO ONE. The old plane had two stores to keep
 * in step (SQLite and IndexedDB), two cursors (the shaped store's and the
 * feed's) and two vocabularies for a read. The seat has one file, one applied
 * cursor and one statement — and the property that made it worth doing is R24:
 * an executed answer clears its overlay IN THE TRANSACTION THAT CARRIES ITS
 * COMMIT, which is only expressible because the outbox is a table in the file
 * the applier writes.
 *
 * THE COPY ARRIVES BEHIND THE SESSION, NEVER IN FRONT OF IT. The first
 * bootstrap is the whole vault file; a session that waited would hold every app
 * on "Loading …". Until it lands `page` and `search` refuse ONLINE_ONLY and the
 * caller falls back through the gateway's paged door (W4-D2, R9) — a working
 * screen, not a broken one. The OUTBOX does not wait: it is the file, not the
 * copy, so a write made before the first sync is durable (`SessionSeat.file`).
 */

import type { Page, PageQuery, PageRequest } from "@centraid/core/page";

import { GatewayClientError } from "../gateway-client-core.js";
import type { GatewayAuth } from "../gateway-client-core.js";
import { clearVaultChangeCursor } from "../vault-change-feed.js";
import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import { replicaIntentInvalidations } from "./intent-invalidations.js";
import type { IntentRecordStore } from "./intent-record-store.js";
import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import { invalidateOutboxMirror } from "./outbox-mirror.js";
import {
  replicaIdentityForGatewayAuth,
  fetchReplicaForScope,
} from "./replica-identity.js";
import { SeatRowKeys, seatBaseVersions } from "./seat/base-versions.js";
import {
  seatChangeInvalidations,
  seatPurgeInvalidation,
} from "./seat/invalidations.js";
import type { SeatReadOverlay } from "./seat/read-overlay.js";
import {
  seatSearchEnvelopes,
  seatSearchUnavailable,
} from "./seat/search-page.js";
import { seatWorkerPage } from "./seat/seat-page-reader.js";
import { SessionSeat } from "./seat/session-seat.js";
import type { SessionSeatHandle } from "./seat/session-seat.js";
import type { SeatWatermark } from "./seat/watermark.js";
import { AdmissionWaiters } from "./shell-admission.js";
import { drainIntents } from "./shell-intent-drain.js";
import { InvalidationBus } from "./shell-invalidation-bus.js";
import { admissionResult, QUEUED_OFFLINE } from "./shell-outcomes.js";
import { purgeShellScope } from "./shell-session-purge.js";
import type {
  ReplicaShellSessionOptions,
  ShellReplicaSearchRequest,
  ShellReplicaWriteInput,
  ShellReplicaWriteResult,
} from "./shell-session-types.js";
import { postReplicaIntent } from "./shell-transport.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import { purgeReplicaIdentityStorage } from "./storage-manifest.js";
import type { ReplicaIdentityInventory } from "./storage-manifest.js";
import type {
  EnqueueIntentInput,
  ReplicaBaseVersion,
  OptimisticMutation,
  ReplicaDependency,
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaSearchWireResult,
  ReplicaValue,
} from "./types.js";
import { prepareReplicaWrite } from "./write-helpers.js";

export type * from "./shell-session-types.js";

export class ReplicaShellSession {
  readonly #fetcher: ReplicaFetcher;
  readonly #eventTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  readonly #isOnline: () => boolean;
  readonly #retryDelayMs: number;
  readonly #indexedDbFactory: IDBFactory | undefined;
  readonly #rememberStorage: boolean;
  readonly #inventory: ReplicaIdentityInventory | undefined;
  readonly #onAuthorizationRevoked:
    | ((session: ReplicaShellSession) => void)
    | undefined;
  readonly #pollIntervalMs: number | undefined;
  readonly #idFactory: (() => string) | undefined;
  readonly #injectedStore: IntentRecordStore | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #drainPromise: Promise<void> | undefined;
  #drainRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #bus = new InvalidationBus();
  readonly #admission: AdmissionWaiters<ShellReplicaWriteResult>;
  #closed = false;
  /**
   * THE SESSION OWNS THE SEAT (#996 wave 4). One file, one applier, one set of
   * OPFS access handles — see `seat/session-seat.ts`. Every consumer asks the
   * session; nothing else opens a `WebSeat`.
   */
  readonly #seat: SessionSeat;
  /**
   * THE QUEUE, OVER THE SEAT'S OWN OUTBOX (#996, R24) — or over memory when
   * there is no seat.
   *
   * A browser that turned "Keep an offline copy" off (R9) holds no file, so it
   * has no `seat_outbox` to queue into. Memory is the honest answer rather
   * than a second durable store: a queue that survived a refresh on a
   * remote-only browser would be local data the member asked it not to keep.
   */
  #queue: IntentQueue | undefined;
  /** The raw store the queue's outbox mirror was built over (#1014, C11). */
  #outboxStore: IntentRecordStore | undefined;
  #rowKeys: SeatRowKeys | undefined;
  #opening: Promise<void> | undefined;

  constructor(
    readonly gatewayAuth: GatewayAuth,
    options: ReplicaShellSessionOptions<ReplicaShellSession> = {}
  ) {
    this.#fetcher = options.fetcher ?? fetchReplicaForScope(gatewayAuth);
    this.#eventTarget = options.eventTarget ?? window;
    this.#isOnline = options.isOnline ?? (() => navigator.onLine !== false);
    this.#retryDelayMs = options.retryDelayMs ?? 2_000;
    this.#indexedDbFactory = options.indexedDbFactory;
    this.#rememberStorage = options.rememberStorage === true;
    this.#inventory = options.inventory;
    this.#onAuthorizationRevoked = options.onAuthorizationRevoked;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#idFactory = options.idFactory;
    this.#injectedStore = options.intentStore;
    this.#admission = new AdmissionWaiters<ShellReplicaWriteResult>(
      // A SETTLED WRITE IS A REASON TO CATCH THE SEAT UP (#996 wave 4). The
      // gateway has committed; the seat is the copy every app reads, and a copy
      // that has not tailed shows the member their own write missing. Not
      // awaited: the answer to the write is the outcome, not the tail.
      (result) => {
        if (result.status === "executed")
          void this.#seat.sync().catch(() => undefined);
      }
    );
    this.#seat = new SessionSeat(gatewayAuth, {
      ...(options.seatOpener ? { opener: options.seatOpener } : {}),
      // THE APPLIER IS THE ONLY SOURCE OF A CANONICAL INVALIDATION NOW. A page
      // lands, the notice names the tables it wrote, and the screens reading
      // those entities re-read. Unsolicited: a seat also applies while nobody
      // is awaiting it.
      onChange: (notice) => this.emit(seatChangeInvalidations(notice)),
      // R24: an executed intent's overlay cleared in the transaction that
      // carried its commit. The pending badge goes with it.
      onOverlaysCleared: (intentIds) => this.settleCleared(intentIds),
    });
  }

  /** The session's one seat, opened on first ask. `undefined` means none. */
  seat(): Promise<SessionSeatHandle | undefined> {
    return this.#seat.open();
  }

  /** Catch the seat up and report how current it is. Quiet on failure. */
  syncSeat(): Promise<SeatWatermark | undefined> {
    return this.#seat.sync();
  }

  /** How current this seat is, or `undefined` before it has said. */
  seatWatermark(): SeatWatermark | undefined {
    return this.#seat.watermark();
  }

  /**
   * ONE PAGE OF ONE APP HANDLER (#996 wave 4, R8).
   *
   * Plain SQL over this seat's own copy of the vault, keyset-paged, with the
   * outbox's pending rows drawn over it. A seat with no file refuses with the
   * code the inline runner already falls back on, and the fallback re-runs the
   * QUERY rather than this one page — a page answered here and the next
   * answered on the gateway would be two walks of two different orderings.
   */
  async page<Row extends object>(
    query: PageQuery<Row>,
    request: PageRequest,
    overlay?: SeatReadOverlay
  ): Promise<Page<Row>> {
    this.assertOpen();
    const seat = await this.seat();
    if (!seat)
      throw new OnlineOnlyError("this seat holds no copy of the vault");
    return seatWorkerPage<Row>(seat, query, request, overlay);
  }

  /**
   * SEARCH RUNS ON THE SEAT (#996, ruling W5-D1) — the gateway's own statement
   * over the vault's FTS shadow tables in this file. `appId` is no longer a
   * scope: one vault, one file, and an entity names its own rows.
   */
  async search(
    appId: string,
    request: ShellReplicaSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const seat = await this.seat();
    if (!seat) throw seatSearchUnavailable(`${appId}/${request.entity}`);
    return seatSearchEnvelopes(seat, {
      entity: request.entity,
      query: request.query,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
  }

  /**
   * Open the scope: get the seat, adopt its outbox, and pick the queue back up.
   *
   * `recoverSending` is what makes a process restart safe — an intent claimed
   * by a drain that never returned is `sending` in a durable table, and only
   * this puts it back at the head of the queue.
   */
  async start(): Promise<this> {
    this.#eventTarget.addEventListener("online", this.onOnline);
    await this.openQueue();
    // THE COPY ARRIVES BEHIND THE SESSION. Not awaited: the first bootstrap is
    // the whole vault file, and every app in the shell is downstream of this
    // open — a session that waited would hold them all on "Loading …".
    void this.#seat.sync().catch(() => undefined);
    await this.#queue?.recoverSending();
    void this.flushIntents();
    if (this.#pollIntervalMs) {
      this.#pollTimer = setInterval(
        () => void this.sync().catch(() => undefined),
        this.#pollIntervalMs
      );
      (this.#pollTimer as unknown as { unref?: () => void }).unref?.();
    }
    return this;
  }

  /** The queue, over whichever store this session got. Memoised on first ask. */
  private async openQueue(): Promise<IntentQueue> {
    if (this.#queue) return this.#queue;
    this.#opening ??= this.buildQueue();
    await this.#opening;
    return this.#queue!;
  }

  private async buildQueue(): Promise<void> {
    // THE FILE, NOT THE FILLED SEAT (#996, R24). A member's first write can
    // happen while the first bootstrap is still downloading, and an outbox that
    // waited would put it in memory and lose it on relaunch.
    const file = await this.#seat.file();
    const store =
      this.#injectedStore ?? file?.outbox() ?? new MemoryIntentStore();
    // Held so `settleCleared` can reach the mirror the queue built over it.
    this.#outboxStore = store;
    if (file) this.#rowKeys = new SeatRowKeys(file);
    this.#queue = new IntentQueue(
      store,
      this.#idFactory ? { idFactory: this.#idFactory } : {}
    );
  }

  /**
   * A write (#996, R23–R25).
   *
   * The order is load-bearing and unchanged from the coordinator's: an edit of
   * a row a QUEUED write already owns revises that intent rather than stacking
   * a second one behind it, because two intents against a row the gateway has
   * never seen is a chain the member did not make.
   */
  async write(
    appId: string,
    input: ShellReplicaWriteInput
  ): Promise<ShellReplicaWriteResult> {
    this.assertOpen();
    if (!input.action)
      throw new ReplicaProtocolError("Replica action is required");
    const queue = await this.openQueue();
    const retained = await queue.pendingIntentForInput(
      appId,
      input.action,
      input.input
    );
    if (retained) {
      const revised = await this.revisePendingWrite(
        retained.intentId,
        input.input,
        retained.expectedActions
      );
      if (revised) return revised;
      throw new ReplicaProtocolError(
        "The pending row is no longer available to edit"
      );
    }
    const { optimistic, dependencies } = prepareReplicaWrite(input.optimistic);
    const baseVersions =
      input.baseVersions ?? (await this.captureBaseVersions(optimistic));
    const matched = await queue.reviseMatchingProjection(
      appId,
      input.action,
      input.input,
      optimistic,
      baseVersions
    );
    if (matched) {
      this.emit(replicaIntentInvalidations([matched.replacement]));
      return this.replacementAdmission(matched.replacement);
    }
    this.#admission.beginRegistration();
    try {
      const intent = await queue.enqueue({
        ...(input.intentId ? { intentId: input.intentId } : {}),
        appId,
        action: input.action,
        input: input.input,
        optimistic,
        dependencies,
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      } satisfies EnqueueIntentInput);
      this.emit(replicaIntentInvalidations([intent]));
      this.assertOpen();
      const existing = admissionResult(intent);
      if (existing) return existing;
      if (!this.#isOnline()) {
        return {
          intentId: intent.intentId,
          status: "queued",
          reason: "waiting for a connection",
        };
      }
      const admitted = this.#admission.await(intent.intentId);
      void this.flushIntents();
      return admitted;
    } finally {
      this.#admission.finishRegistration();
    }
  }

  /**
   * The versions a write is against, from CANONICAL rows only (#922 G5).
   *
   * The overlay is bypassed deliberately: a queued edit must not become its own
   * base version, and a retry must observe the row that rejected it. A seat with
   * no file states no preconditions — there is nothing local to read them from,
   * and the gateway is about to see the rows anyway.
   */
  private async captureBaseVersions(
    optimistic: readonly OptimisticMutation[]
  ): Promise<ReplicaBaseVersion[]> {
    // The FILLED seat: a base version read off an empty file would be no
    // version at all, which is a precondition silently dropped.
    const seat = await this.seat();
    const keys = this.#rowKeys;
    if (!seat || !keys || optimistic.length === 0) return [];
    return seatBaseVersions(seat, keys, optimistic);
  }

  async discardPendingWrite(intentId: string): Promise<boolean> {
    this.assertOpen();
    const queue = await this.openQueue();
    const existing = (await queue.list()).find(
      (intent) => intent.intentId === intentId
    );
    const discarded = await queue.discard(intentId);
    if (discarded && existing)
      this.emit(replicaIntentInvalidations([existing]));
    return discarded;
  }

  async revisePendingWrite(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<ShellReplicaWriteResult | undefined> {
    return this.replaceIntent(intentId, (queue, refreshed) =>
      queue.revise(intentId, revision, refreshed, expectedActions)
    );
  }

  async retryPendingWrite(
    intentId: string
  ): Promise<ShellReplicaWriteResult | undefined> {
    return this.replaceIntent(intentId, (queue, refreshed) =>
      queue.retry(intentId, refreshed)
    );
  }

  /**
   * Revise or retry: one intent replaced by another, with FRESH base versions.
   *
   * Re-capturing is the point (#922 G5). A retry must observe the row that
   * rejected it — reusing the version the first attempt was against would send
   * the same doomed precondition again, forever.
   */
  private async replaceIntent(
    intentId: string,
    replace: (
      queue: IntentQueue,
      refreshed: ReplicaBaseVersion[]
    ) => Promise<ReplicaIntent | undefined>
  ): Promise<ShellReplicaWriteResult | undefined> {
    this.assertOpen();
    const queue = await this.openQueue();
    const previous = (await queue.list()).find(
      (intent) => intent.intentId === intentId
    );
    const replacement = await replace(
      queue,
      previous ? await this.captureBaseVersions(previous.optimistic) : []
    );
    if (!replacement) return undefined;
    if (previous) this.emit(replicaIntentInvalidations([previous]));
    this.emit(replicaIntentInvalidations([replacement]));
    return this.replacementAdmission(replacement);
  }

  private replacementAdmission(
    replacement: ReplicaIntent
  ): ShellReplicaWriteResult {
    if (!this.#isOnline())
      return {
        intentId: replacement.intentId,
        status: "queued",
        reason: "waiting for a connection",
      };
    void this.flushIntents();
    return { intentId: replacement.intentId, status: "in-flight" };
  }

  /**
   * What a screen asks to be told about (#996, W5) — by ENTITY.
   *
   * `appId` no longer selects anything: a shape was an app's slice of a vault
   * and there is one slice now. It stays in the signature because every caller
   * has it and passes it, and removing it would be churn at forty call sites
   * for a parameter the next thing to need it would have to add back.
   */
  subscribe(
    appId: string,
    dependencies: ReplicaDependency[] | undefined,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    this.assertOpen();
    void appId;
    return this.#bus.subscribe(dependencies, listener);
  }

  private emit(invalidations: readonly ReplicaInvalidation[]): void {
    this.#bus.emit(invalidations);
  }

  /**
   * R24's other half, on the shell side: the applier cleared these overlays
   * inside the commit's transaction, so the writers still awaiting them are
   * settled and the badges they were drawn with go.
   */
  private settleCleared(intentIds: readonly string[]): void {
    // THE MIRROR DID NOT SEE THIS WRITE (#1014, C11). The rows went from
    // `seat_outbox` inside the applier's transaction, on the seat's own
    // connection — not through the proxy the mirror invalidates on — so
    // without this the overlay goes on drawing a pending badge over rows that
    // have already landed, for as long as nothing else writes.
    invalidateOutboxMirror(this.#outboxStore);
    for (const intentId of intentIds)
      this.#admission.resolve(intentId, { intentId, status: "executed" });
  }

  /** Catch the seat up. First fill and every delta take the same path. */
  async sync(): Promise<void> {
    this.assertOpen();
    await this.#seat.sync().catch(() => undefined);
  }

  async flushIntents(): Promise<void> {
    if (this.#closed) return;
    if (!this.#isOnline()) {
      this.queueEveryoneWaiting(QUEUED_OFFLINE);
      return;
    }
    if (this.#drainPromise) {
      this.#drainRequested = true;
      return this.#drainPromise;
    }
    this.#drainRequested = false;
    this.#drainPromise = this.drainLoop().finally(() => {
      this.#drainPromise = undefined;
      if (this.#drainRequested) {
        this.#drainRequested = false;
        void this.flushIntents();
      }
    });
    return this.#drainPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#admission.rejectAll(
      new ReplicaProtocolError("Replica session closed")
    );
    this.detach();
    this.#queue?.close();
    await this.#seat.close();
  }

  /** Unpair/revoke/vault-switch terminal cleanup for this scope's storage. */
  async purge(): Promise<void> {
    clearVaultChangeCursor(this.gatewayAuth);
    const identity = replicaIdentityForGatewayAuth(this.gatewayAuth);
    if (this.#closed) {
      if (this.#rememberStorage)
        await purgeReplicaIdentityStorage(identity, {
          ...(this.#indexedDbFactory
            ? { indexedDbFactory: this.#indexedDbFactory }
            : {}),
          ...(this.#inventory ? { inventory: this.#inventory } : {}),
        });
      return;
    }
    this.#closed = true;
    this.#admission.rejectAll(
      new ReplicaProtocolError("Replica session purged")
    );
    this.detach();
    this.emit(seatPurgeInvalidation());
    this.#bus.clear();
    await purgeShellScope({
      identity,
      seat: this.#seat,
      queue: this.#queue,
      remembered: this.#rememberStorage,
      indexedDbFactory: this.#indexedDbFactory,
      inventory: this.#inventory,
    });
  }

  /**
   * The gateway said this seat's copy is unusable — below the retention floor,
   * or from another epoch. A bootstrap is a FILE COPY now, so the answer is one
   * sync: `SeatLoop` bootstraps when it has no state and re-bootstraps once per
   * sync on a drift refusal, carrying the outbox and the pins across.
   */
  requireBootstrap(): void {
    if (this.#closed) return;
    this.emit(seatPurgeInvalidation());
    void this.#seat.sync().catch(() => undefined);
  }

  private async drainLoop(): Promise<void> {
    const queue = await this.openQueue();
    return drainIntents({
      queue,
      send: (intent) =>
        postReplicaIntent(this.gatewayAuth, intent, this.#fetcher),
      closed: () => this.#closed,
      online: () => this.#isOnline(),
      settleRegistrations: () => this.#admission.settleRegistrations(),
      resolve: (intentId, result) => this.#admission.resolve(intentId, result),
      reject: (intentId, error) => this.#admission.reject(intentId, error),
      rejectAll: (error) => this.#admission.rejectAll(error),
      queueEveryoneWaiting: (reason) => this.queueEveryoneWaiting(reason),
      settled: (intent) => this.emit(replicaIntentInvalidations([intent])),
      isAuthorizationError,
      onAuthorizationRevoked: () => this.#onAuthorizationRevoked?.(this),
      scheduleRetry: () => this.scheduleRetry(),
    });
  }

  /** Settle every writer still waiting on its durable admission (#880). */
  private queueEveryoneWaiting(reason: string): void {
    this.#admission.resolveAllAsQueued(reason, (intentId) => ({
      intentId,
      status: "queued" as const,
    }));
  }

  private scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushIntents();
    }, this.#retryDelayMs);
  }

  private readonly onOnline = (): void => {
    void this.flushIntents();
    void this.#seat.sync().catch(() => undefined);
  };

  private detach(): void {
    this.#eventTarget.removeEventListener("online", this.onOnline);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#drainRequested = false;
  }

  private assertOpen(): void {
    if (this.#closed)
      throw new ReplicaProtocolError("Replica session is closed");
  }
}

export function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === "auth_required";
}

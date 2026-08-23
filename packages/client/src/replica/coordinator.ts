// governance: allow-repo-hygiene file-size-limit (#738) coordinator ordering keeps bootstrap, feed catch-up, canonical reads, and durable intent invalidation in one crash-consistency boundary
import type { VaultChangeMessage } from "../vault-change-sse.js";
import {
  OnlineOnlyGuard,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from "./errors.js";
import { replicaIntentInvalidations } from "./intent-invalidations.js";
import type {
  IntentQueue,
  IntentQueueOptions,
  PendingIntentReplacement,
} from "./intents.js";
import { LiveQueryRegistry } from "./live-query-registry.js";
import { LiveQuery } from "./live-query.js";
import type { ReplicaStore } from "./store.js";
import type {
  EnqueueIntentInput,
  IntentOutcome,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaReadRequest,
  ReplicaReadResult,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaStatus,
  ReplicaValue,
} from "./types.js";

export interface ReplicaChangeFeedAdapter {
  /** Pass `subscribeVaultChanges` from the shell-owned singleton feed. */
  subscribe: (listener: (message: VaultChangeMessage) => void) => () => void;
  /** Attest the exact catalog stored locally before opening/resuming a feed. */
  setShapeIds: (shapeIds: readonly string[]) => Promise<void>;
  /** Pass `resumeVaultChanges`; called only after an atomic bootstrap commits. */
  resume: (cursor: ReplicaCursor) => Promise<void>;
}

export type ReplicaChangePuller = (
  cursor: ReplicaCursor,
  signal: AbortSignal
) => Promise<ReplicaChangeBatch | undefined>;

export interface ReplicaCoordinatorOptions extends IntentQueueOptions {
  changeFeed?: ReplicaChangeFeedAdapter;
  pullChanges?: ReplicaChangePuller;
  /** Bounded retry for a failed pull even when the shared SSE cursor already advanced. */
  feedRetryDelayMs?: number;
  onRebootstrapRequired?: (detail: unknown) => void;
  onCursorAdvanced?: (cursor: ReplicaCursor, schemaEpoch: string) => void;
}

export interface ReplicaCoordinatorCreated {
  replica: ReplicaCoordinator;
  status: ReplicaStatus;
}

/** Owns one gateway/vault database, its intent overlay and local live queries. */
export class ReplicaCoordinator {
  readonly #live = new LiveQueryRegistry();
  readonly #invalidationListeners = new Set<
    (invalidations: readonly ReplicaInvalidation[]) => void
  >();
  readonly #feed: ReplicaChangeFeedAdapter | undefined;
  readonly #pullChanges: ReplicaChangePuller | undefined;
  readonly #feedRetryDelayMs: number;
  readonly #onRebootstrapRequired: ((detail: unknown) => void) | undefined;
  readonly #onCursorAdvanced:
    | ((cursor: ReplicaCursor, schemaEpoch: string) => void)
    | undefined;
  #unsubscribeFeed: (() => void) | undefined;
  #feedTarget: ReplicaCursor | undefined;
  #feedSync: Promise<void> | undefined;
  #feedAbort: AbortController | undefined;
  #feedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #feedGeneration = 0;
  /**
   * True between `bootstrapBegin` and `bootstrapCommit`. The walk owns the store
   * across that span: `replica_bootstrap_progress` is the only proof a bootstrap
   * is open, and anything that clears it mid-walk makes the next page or the
   * commit fail with "No replica bootstrap is open".
   */
  #bootstrapOpen = false;
  /** A rebootstrap demanded mid-walk, re-raised once the walk seals. */
  #deferredRebootstrap: { detail: unknown } | undefined;
  #feedFailureSignature: string | undefined;
  #feedFailureCount = 0;
  #closed = false;

  constructor(
    readonly worker: ReplicaStore,
    readonly intents: IntentQueue,
    options: Pick<
      ReplicaCoordinatorOptions,
      | "changeFeed"
      | "pullChanges"
      | "feedRetryDelayMs"
      | "onRebootstrapRequired"
      | "onCursorAdvanced"
    > = {}
  ) {
    if (options.changeFeed && !options.pullChanges) {
      throw new ReplicaProtocolError(
        "A replica change feed requires a change puller"
      );
    }
    this.#feed = options.changeFeed;
    this.#pullChanges = options.pullChanges;
    this.#feedRetryDelayMs = options.feedRetryDelayMs ?? 1_000;
    this.#onRebootstrapRequired = options.onRebootstrapRequired;
    this.#onCursorAdvanced = options.onCursorAdvanced;
    if (this.#feed)
      this.#unsubscribeFeed = this.#feed.subscribe(this.onFeedMessage);
  }

  async bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor> {
    this.resetFeedGeneration();
    // Reconcile durable IDB before advancing SQLite, matching incremental apply.
    const resolved = await this.intents.applyOutcomes(snapshot.outcomes ?? []);
    const cursor = await this.worker.bootstrap(snapshot);
    await this.#feed?.setShapeIds(
      snapshot.shapes.map((shape) => shape.shapeId)
    );
    await this.#feed?.resume(cursor);
    this.#onCursorAdvanced?.(cursor, snapshot.schemaEpoch);
    this.emitInvalidations([
      { shapeId: "*", entity: "*", source: "purge" },
      ...replicaIntentInvalidations(resolved),
    ]);
    return cursor;
  }

  /**
   * Windowed bootstrap, page-wise. The feed stays detached and no cursor is
   * published until {@link bootstrapCommit}, so an interrupted walk leaves the
   * replica reporting "not bootstrapped" rather than a partial catalog.
   */
  async bootstrapBegin(header: ReplicaBootstrapHeader): Promise<void> {
    this.resetFeedGeneration();
    // Claimed BEFORE the call is posted, not after it resolves. Store calls are
    // ordered by when they are issued (the web store is a worker RPC queue), so
    // a `requireRebootstrap` that has already posted its wipe posted it ahead of
    // this begin and is harmless; every later one must be held off instead.
    this.#bootstrapOpen = true;
    await this.walkStep(() => this.worker.bootstrapBegin(header));
    this.emitInvalidations([{ shapeId: "*", entity: "*", source: "purge" }]);
  }

  async bootstrapPage(rows: ReplicaSnapshotRow[]): Promise<void> {
    await this.walkStep(() => this.worker.bootstrapPage(rows));
    this.emitInvalidations([
      { shapeId: "*", entity: "*", source: "canonical" },
    ]);
  }

  async bootstrapPreview(cursor: ReplicaCursor): Promise<void> {
    await this.walkStep(async () => this.worker.bootstrapPreview?.(cursor));
    this.emitInvalidations([
      { shapeId: "*", entity: "*", source: "canonical" },
    ]);
  }

  /**
   * Run one step of an open windowed walk. A rejected step ends the walk — the
   * driver will not reach `bootstrapCommit` — so the claim on the store is
   * released. The error is rethrown untouched; this is bookkeeping, not rescue.
   */
  private async walkStep<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      this.#bootstrapOpen = false;
      throw error;
    }
  }

  /**
   * Seal at the page-1 cursor and attach the feed there. The caller must still
   * replay changes from this cursor — later pages came from later snapshots, and
   * only the replay repairs what slipped between them (notably deletions).
   */
  async bootstrapCommit(
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader,
    outcomes: IntentOutcome[] = []
  ): Promise<ReplicaCursor> {
    const resolved = await this.intents.applyOutcomes(outcomes);
    const committed = await this.walkStep(() =>
      this.worker.bootstrapCommit(cursor)
    );
    this.#bootstrapOpen = false;
    await this.#feed?.setShapeIds(header.shapes.map((shape) => shape.shapeId));
    await this.#feed?.resume(committed);
    this.#onCursorAdvanced?.(committed, header.schemaEpoch);
    this.emitInvalidations([
      { shapeId: "*", entity: "*", source: "purge" },
      ...replicaIntentInvalidations(resolved),
    ]);
    const deferred = this.#deferredRebootstrap;
    if (deferred) {
      this.#deferredRebootstrap = undefined;
      await this.requireRebootstrap(deferred.detail);
    }
    return committed;
  }

  async applyChanges(batch: ReplicaChangeBatch): Promise<ReplicaCursor> {
    try {
      // IDB first: a crash can leave canonical data behind (rebootstrap repairs it),
      // but must never advance the SQLite cursor while retaining a stale overlay.
      const resolved = await this.intents.applyOutcomes(batch.outcomes ?? []);
      const applied = await this.worker.applyChanges(batch);
      this.#onCursorAdvanced?.(applied.cursor, batch.schemaEpoch);
      this.emitInvalidations([
        ...applied.invalidations,
        ...replicaIntentInvalidations(resolved),
      ]);
      return applied.cursor;
    } catch (error) {
      if (error instanceof ReplicaRebootstrapRequiredError) {
        await this.requireRebootstrap(error);
      }
      throw error;
    }
  }

  async read(
    request: ReplicaReadRequest,
    guard: OnlineOnlyGuard = new OnlineOnlyGuard()
  ): Promise<ReplicaReadResult> {
    const optimistic = await this.intents.overlayMutations(
      request.shapeId,
      request.entity
    );
    return this.worker.read(request, optimistic, guard);
  }

  /** Clone-safe equivalent used by the shell's MessagePort transport. */
  async readWire(request: ReplicaReadRequest): Promise<ReplicaReadWireResult> {
    const optimistic = await this.intents.overlayMutations(
      request.shapeId,
      request.entity
    );
    return this.worker.readWire(request, optimistic);
  }

  /** Clone-safe local search used by the shell's MessagePort transport. */
  async searchWire(
    request: ReplicaSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    const optimistic = await this.intents.overlayMutations(
      request.shapeId,
      request.entity
    );
    return this.worker.searchWire(request, optimistic);
  }

  liveRead(request: ReplicaReadRequest): LiveQuery<ReplicaReadResult> {
    return this.#live.track(
      new LiveQuery(async (signal) => {
        if (signal.aborted) {
          const reason = (signal as { reason?: unknown }).reason;
          if (reason instanceof Error) throw reason;
          throw new Error("aborted", { cause: reason });
        }
        const value = await this.read(request);
        return { value, dependencies: [value.dependency] };
      })
    );
  }

  async enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent> {
    const intent = await this.intents.enqueue(input);
    this.emitInvalidations(replicaIntentInvalidations([intent]));
    return intent;
  }

  /**
   * Capture concurrency preconditions from canonical rows only. Optimistic
   * overlays are deliberately bypassed: a queued edit must not become its own
   * base version, and a retry must observe the row that rejected it.
   */
  async captureBaseVersions(
    mutations: readonly OptimisticMutation[]
  ): Promise<ReplicaBaseVersion[]> {
    const catalog = await this.worker.catalog();
    const unique = new Map<string, OptimisticMutation>();
    for (const mutation of mutations)
      unique.set(
        `${mutation.shapeId}\u0000${mutation.entity}\u0000${mutation.rowId}`,
        mutation
      );
    const captured = await Promise.all(
      [...unique.values()].map(
        async (mutation): Promise<ReplicaBaseVersion | undefined> => {
          const shape = catalog.find(
            (candidate) => candidate.shapeId === mutation.shapeId
          );
          const schema = shape?.entities.find(
            (candidate) => candidate.entity === mutation.entity
          );
          if (!schema) return undefined;
          const result = await this.worker.readWire({
            shapeId: mutation.shapeId,
            entity: mutation.entity,
            where: [
              {
                column: schema.primaryKey,
                op: "eq",
                value: mutation.rowId,
              },
            ],
            limit: 1,
          });
          const row = result.rows.find(
            (candidate) => candidate.rowId === mutation.rowId
          );
          return row?.rowVersion === undefined
            ? undefined
            : {
                shapeId: mutation.shapeId,
                entity: mutation.entity,
                rowId: mutation.rowId,
                version: row.rowVersion,
              };
        }
      )
    );
    return captured.filter(
      (version): version is ReplicaBaseVersion => version !== undefined
    );
  }

  claimNextIntent(): Promise<ReplicaIntent | undefined> {
    return this.intents.claimNext();
  }

  markIntentTransportFailed(
    intentId: string,
    reason?: string
  ): Promise<ReplicaIntent> {
    return this.intents.transportFailed(intentId, reason);
  }

  markIntentAwaitingChange(intentId: string): Promise<ReplicaIntent> {
    return this.intents.awaitingChange(intentId);
  }

  async applyIntentOutcome(
    outcome: IntentOutcome
  ): Promise<ReplicaIntent | undefined> {
    const [intent] = await this.intents.applyOutcomes([outcome]);
    if (intent) this.emitInvalidations(replicaIntentInvalidations([intent]));
    return intent;
  }

  status(): Promise<ReplicaStatus> {
    return this.worker.status();
  }

  catalog(): Promise<ReplicaShape[]> {
    return this.worker.catalog();
  }

  recoverSending(): Promise<ReplicaIntent[]> {
    return this.intents.recoverSending();
  }

  pendingIntents(): Promise<ReplicaIntent[]> {
    return this.intents.pending();
  }

  async discardIntent(intentId: string): Promise<boolean> {
    const existing = (await this.intents.list()).find(
      (intent) => intent.intentId === intentId
    );
    const discarded = await this.intents.discard(intentId);
    if (discarded && existing)
      this.emitInvalidations(replicaIntentInvalidations([existing]));
    return discarded;
  }

  async retryIntent(intentId: string): Promise<ReplicaIntent | undefined> {
    const previous = (await this.intents.list()).find(
      (intent) => intent.intentId === intentId
    );
    const refreshedBaseVersions = previous
      ? await this.captureBaseVersions(previous.optimistic)
      : [];
    const replacement = await this.intents.retry(
      intentId,
      refreshedBaseVersions
    );
    if (previous)
      this.emitInvalidations(replicaIntentInvalidations([previous]));
    if (replacement)
      this.emitInvalidations(replicaIntentInvalidations([replacement]));
    return replacement;
  }

  async reviseIntent(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<ReplicaIntent | undefined> {
    const previous = (await this.intents.list()).find(
      (intent) => intent.intentId === intentId
    );
    const refreshedBaseVersions = previous
      ? await this.captureBaseVersions(previous.optimistic)
      : [];
    const replacement = await this.intents.revise(
      intentId,
      revision,
      refreshedBaseVersions,
      expectedActions
    );
    if (previous)
      this.emitInvalidations(replicaIntentInvalidations([previous]));
    if (replacement)
      this.emitInvalidations(replicaIntentInvalidations([replacement]));
    return replacement;
  }

  async reviseIntentForProjection(
    appId: string,
    action: string,
    revision: ReplicaValue,
    optimistic: readonly OptimisticMutation[],
    refreshedBaseVersions?: ReplicaBaseVersion[]
  ): Promise<PendingIntentReplacement | undefined> {
    const result = await this.intents.reviseMatchingProjection(
      appId,
      action,
      revision,
      optimistic,
      refreshedBaseVersions
    );
    if (!result) return undefined;
    this.emitInvalidations(replicaIntentInvalidations([result.replacement]));
    return result;
  }

  subscribeInvalidations(
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detachFeed();
    this.#invalidationListeners.clear();
    this.#live.dispose();
    this.intents.close();
    await this.worker.close();
  }

  /** Unpair/revoke/vault-switch terminal cleanup for OPFS, IDB and live state. */
  async purge(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detachFeed();
    this.emitInvalidations([{ shapeId: "*", entity: "*", source: "purge" }]);
    this.#invalidationListeners.clear();
    this.#live.dispose();
    await Promise.all([this.worker.purge(), this.intents.purge()]);
  }

  private readonly onFeedMessage = (message: VaultChangeMessage): void => {
    if (message.type === "centraid:vault-rebootstrap") {
      void this.requireRebootstrap(message.detail);
      return;
    }
    const cursor =
      message.type === "centraid:vault-cursor"
        ? message.cursor
        : message.detail.cursor;
    if (!this.#feedTarget || cursorAfter(cursor, this.#feedTarget))
      this.#feedTarget = cursor;
    this.startFeedSync();
  };

  private startFeedSync(): void {
    if (
      this.#feedSync ||
      this.#feedRetryTimer ||
      this.#closed ||
      !this.#feedTarget
    )
      return;
    this.#feedSync = this.syncFromFeed()
      .then((caughtUp) => {
        if (!caughtUp) this.scheduleFeedRetry();
      })
      .catch(() => this.scheduleFeedRetry())
      .finally(() => {
        this.#feedSync = undefined;
        if (this.#feedTarget && !this.#feedRetryTimer) this.startFeedSync();
      });
  }

  private async syncFromFeed(): Promise<boolean> {
    if (!this.#pullChanges || this.#closed) return true;
    const pullChanges = this.#pullChanges;
    const generation = this.#feedGeneration;
    const abort = new AbortController();
    this.#feedAbort = abort;
    const syncNextFeedTarget = async (): Promise<boolean> => {
      if (!this.#feedTarget || abort.signal.aborted)
        return abort.signal.aborted || !this.#feedTarget;
      const target = this.#feedTarget;
      const status = await this.worker.status();
      if (!status.cursor) return false;
      if (!cursorAfter(target, status.cursor)) {
        this.clearReachedFeedTarget(status.cursor);
        return syncNextFeedTarget();
      }
      let batch: ReplicaChangeBatch | undefined;
      try {
        batch = await pullChanges(status.cursor, abort.signal);
      } catch (error) {
        if (error instanceof ReplicaRebootstrapRequiredError) {
          await this.requireRebootstrap(error);
          return true;
        }
        throw error;
      }
      if (!batch) return false;
      if (abort.signal.aborted || generation !== this.#feedGeneration)
        return true;
      const cursor = await this.applyChanges(batch);
      if (!cursorAfter(cursor, status.cursor)) {
        if (this.recordFeedFailure("non-progress")) {
          await this.requireRebootstrap({
            reason: "replica feed made no cursor progress",
          });
          return true;
        }
        return false;
      }
      this.clearFeedFailures();
      this.clearReachedFeedTarget(cursor);
      return syncNextFeedTarget();
    };
    try {
      return await syncNextFeedTarget();
    } catch (error) {
      if (
        error instanceof ReplicaProtocolError &&
        this.recordFeedFailure(`${error.name}:${error.message}`)
      ) {
        await this.requireRebootstrap(error);
        return true;
      }
      throw error;
    } finally {
      if (this.#feedAbort === abort) this.#feedAbort = undefined;
    }
  }

  /**
   * Pull the gateway's outstanding changes RIGHT NOW, resolving once the local
   * cursor has caught up with whatever the gateway holds.
   *
   * The feed path above is push-driven: a sync starts when the SSE nudge
   * lands, which can be moments AFTER the write that caused it resolved to its
   * caller. A caller that has just finished a gateway-side write and is about
   * to re-read (Home's sample seed is the case that forced this) needs the
   * inverse — "the rows I know exist are readable locally" — so this pulls
   * from the current cursor until a batch reports no further progress. It
   * borrows the feed's single-flight slot so the two paths never apply
   * batches concurrently.
   *
   * A replica with no cursor has nothing to advance — the bootstrap walk owns
   * the first fill — and a coordinator without a puller is bootstrap-only;
   * both resolve immediately.
   */
  async syncNow(): Promise<void> {
    if (!this.#pullChanges || this.#closed) return;
    // Ride out any in-flight feed sync first: the two would otherwise pull
    // from the same cursor and post the same batch to the store twice.
    await this.awaitFeedSyncIdle();
    if (this.#closed) return;
    const run = this.pullToHead();
    this.#feedSync = run.then(
      () => undefined,
      () => undefined
    );
    try {
      await run;
    } finally {
      this.#feedSync = undefined;
      // A feed nudge that arrived while we pulled may point past where this
      // stopped; hand the slot back to the push path rather than dropping it.
      if (this.#feedTarget && !this.#feedRetryTimer) this.startFeedSync();
    }
  }

  /** Chain behind the feed's single-flight slot until it is free. */
  private async awaitFeedSyncIdle(): Promise<void> {
    const inFlight = this.#feedSync;
    if (!inFlight) return;
    await inFlight;
    return this.awaitFeedSyncIdle();
  }

  private async pullToHead(): Promise<void> {
    const pullChanges = this.#pullChanges;
    if (!pullChanges) return;
    const generation = this.#feedGeneration;
    const abort = new AbortController();
    this.#feedAbort = abort;
    const pullNextBatch = async (): Promise<void> => {
      if (this.#closed || abort.signal.aborted) return;
      const status = await this.worker.status();
      if (!status.cursor) return;
      let batch: ReplicaChangeBatch | undefined;
      try {
        batch = await pullChanges(status.cursor, abort.signal);
      } catch (error) {
        if (error instanceof ReplicaRebootstrapRequiredError) {
          await this.requireRebootstrap(error);
          return;
        }
        throw error;
      }
      if (!batch || abort.signal.aborted || generation !== this.#feedGeneration)
        return;
      if (!cursorAfter(batch.to, status.cursor)) {
        // Already at the head. A stale feed target at or below it is done too.
        this.clearReachedFeedTarget(status.cursor);
        return;
      }
      let cursor: ReplicaCursor;
      try {
        cursor = await this.applyChanges(batch);
      } catch (error) {
        // `applyChanges` already turned a rebootstrap demand into wipe +
        // demand; this catch-up ends either way and must not demand twice.
        if (error instanceof ReplicaRebootstrapRequiredError) return;
        throw error;
      }
      this.clearReachedFeedTarget(cursor);
      if (batch.hasMore === true) return pullNextBatch();
    };
    try {
      await pullNextBatch();
    } finally {
      if (this.#feedAbort === abort) this.#feedAbort = undefined;
    }
  }

  private clearReachedFeedTarget(cursor: ReplicaCursor): void {
    if (this.#feedTarget && !cursorAfter(this.#feedTarget, cursor)) {
      this.#feedTarget = undefined;
    }
  }

  private scheduleFeedRetry(): void {
    if (this.#feedRetryTimer || this.#closed || !this.#feedTarget) return;
    this.#feedRetryTimer = setTimeout(() => {
      this.#feedRetryTimer = undefined;
      this.startFeedSync();
    }, this.#feedRetryDelayMs);
  }

  private async requireRebootstrap(detail: unknown): Promise<void> {
    if (isBootstrapSentinelRebootstrap(detail)) {
      // `since=0:0` answers `reason: "initial"` — resume, do not wipe.
      this.resetFeedGeneration();
      const status = await this.worker.status();
      if (status.cursor) await this.#feed?.resume(status.cursor);
      return;
    }
    this.resetFeedGeneration();
    if (this.#bootstrapOpen) {
      // A windowed walk already owns the store. Wiping under it would delete
      // `replica_bootstrap_progress` between two pages — the walk's next page or
      // its commit would then throw "No replica bootstrap is open", killing a
      // bootstrap that was about to rebuild the replica anyway. The wipe is also
      // redundant here: `bootstrapBegin` cleared the store, and no cursor is
      // published until commit, so nothing stale is readable meanwhile. Hold the
      // demand and re-raise it once the walk seals.
      this.#deferredRebootstrap = { detail };
      return;
    }
    await this.worker.wipe().catch(() => undefined);
    this.emitInvalidations([{ shapeId: "*", entity: "*", source: "purge" }]);
    this.#onRebootstrapRequired?.(detail);
  }

  private detachFeed(): void {
    this.resetFeedGeneration();
    this.#unsubscribeFeed?.();
    this.#unsubscribeFeed = undefined;
  }

  private resetFeedGeneration(): void {
    this.#feedGeneration += 1;
    this.#feedAbort?.abort();
    this.#feedAbort = undefined;
    this.#feedTarget = undefined;
    if (this.#feedRetryTimer) clearTimeout(this.#feedRetryTimer);
    this.#feedRetryTimer = undefined;
    this.clearFeedFailures();
  }

  private recordFeedFailure(signature: string): boolean {
    if (this.#feedFailureSignature === signature) this.#feedFailureCount += 1;
    else {
      this.#feedFailureSignature = signature;
      this.#feedFailureCount = 1;
    }
    return this.#feedFailureCount >= 3;
  }

  private clearFeedFailures(): void {
    this.#feedFailureSignature = undefined;
    this.#feedFailureCount = 0;
  }

  private emitInvalidations(invalidations: ReplicaInvalidation[]): void {
    this.#live.invalidate(invalidations);
    for (const listener of this.#invalidationListeners) {
      try {
        listener(invalidations);
      } catch {
        /* A failed iframe subscriber must not starve local live queries. */
      }
    }
  }
}

function cursorAfter(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch !== right.epoch || left.seq > right.seq;
}

function isBootstrapSentinelRebootstrap(detail: unknown): boolean {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { reason?: unknown }).reason === "initial"
  );
}

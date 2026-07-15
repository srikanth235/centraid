import type { VaultChangeMessage } from '../vault-change-feed.js';
import {
  OnlineOnlyGuard,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
} from './errors.js';
import { IndexedDbIntentStore, MemoryIntentStore, type IntentRecordStore } from './intent-store.js';
import { IntentQueue, type IntentQueueOptions } from './intents.js';
import { replicaIntentDatabaseName } from './key.js';
import { LiveQueryRegistry } from './live-query-registry.js';
import { LiveQuery } from './live-query.js';
import type {
  EnqueueIntentInput,
  IntentOutcome,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaIdentity,
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
} from './types.js';
import { ReplicaWorkerClient, type ReplicaWorkerFactory } from './worker-client.js';

export interface ReplicaChangeFeedAdapter {
  /** Pass `subscribeVaultChanges` from the shell-owned singleton feed. */
  subscribe(listener: (message: VaultChangeMessage) => void): () => void;
  /** Attest the exact catalog stored locally before opening/resuming a feed. */
  setShapeIds(shapeIds: readonly string[]): Promise<void>;
  /** Pass `resumeVaultChanges`; called only after an atomic bootstrap commits. */
  resume(cursor: ReplicaCursor): Promise<void>;
}

export type ReplicaChangePuller = (
  cursor: ReplicaCursor,
  signal: AbortSignal,
) => Promise<ReplicaChangeBatch | undefined>;

export interface ReplicaCoordinatorOptions extends IntentQueueOptions {
  workerFactory?: ReplicaWorkerFactory;
  intentStore?: IntentRecordStore;
  indexedDbFactory?: IDBFactory;
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
  readonly #onCursorAdvanced: ((cursor: ReplicaCursor, schemaEpoch: string) => void) | undefined;
  #unsubscribeFeed: (() => void) | undefined;
  #feedTarget: ReplicaCursor | undefined;
  #feedSync: Promise<void> | undefined;
  #feedAbort: AbortController | undefined;
  #feedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    readonly worker: ReplicaWorkerClient,
    readonly intents: IntentQueue,
    options: Pick<
      ReplicaCoordinatorOptions,
      | 'changeFeed'
      | 'pullChanges'
      | 'feedRetryDelayMs'
      | 'onRebootstrapRequired'
      | 'onCursorAdvanced'
    > = {},
  ) {
    if (options.changeFeed && !options.pullChanges) {
      throw new ReplicaProtocolError('A replica change feed requires a change puller');
    }
    this.#feed = options.changeFeed;
    this.#pullChanges = options.pullChanges;
    this.#feedRetryDelayMs = options.feedRetryDelayMs ?? 1_000;
    this.#onRebootstrapRequired = options.onRebootstrapRequired;
    this.#onCursorAdvanced = options.onCursorAdvanced;
    if (this.#feed) this.#unsubscribeFeed = this.#feed.subscribe(this.onFeedMessage);
  }

  static async create(
    identity: ReplicaIdentity,
    remember: boolean,
    options: ReplicaCoordinatorOptions = {},
  ): Promise<ReplicaCoordinatorCreated> {
    const { client, status } = await ReplicaWorkerClient.create(
      identity,
      remember,
      options.workerFactory,
    );
    try {
      const store =
        options.intentStore ??
        (status.mode === 'opfs-sahpool' && (options.indexedDbFactory ?? globalThis.indexedDB)
          ? await openIndexedDb(identity, options.indexedDbFactory ?? globalThis.indexedDB)
          : new MemoryIntentStore());
      const intents = new IntentQueue(store, { idFactory: options.idFactory });
      // A remembered OPFS cursor must attest its catalog and seed the shell
      // feed before it attaches; otherwise a new renderer can adopt a reduced
      // server shape and keep stale consented rows readable.
      if (status.cursor && options.changeFeed) {
        const shapeIds = (await client.catalog()).map((shape) => shape.shapeId);
        await options.changeFeed.setShapeIds(shapeIds);
        await options.changeFeed.resume(status.cursor);
      }
      return { replica: new ReplicaCoordinator(client, intents, options), status };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor> {
    this.resetFeedGeneration();
    // Reconcile durable IDB before advancing SQLite, matching incremental apply.
    const resolved = await this.intents.applyOutcomes(snapshot.outcomes ?? []);
    const cursor = await this.worker.bootstrap(snapshot);
    await this.#feed?.setShapeIds(snapshot.shapes.map((shape) => shape.shapeId));
    await this.#feed?.resume(cursor);
    this.#onCursorAdvanced?.(cursor, snapshot.schemaEpoch);
    this.emitInvalidations([
      { shapeId: '*', entity: '*', source: 'purge' },
      ...overlayInvalidations(resolved),
    ]);
    return cursor;
  }

  async applyChanges(batch: ReplicaChangeBatch): Promise<ReplicaCursor> {
    try {
      // IDB first: a crash can leave canonical data behind (rebootstrap repairs it),
      // but must never advance the SQLite cursor while retaining a stale overlay.
      const resolved = await this.intents.applyOutcomes(batch.outcomes ?? []);
      const applied = await this.worker.applyChanges(batch);
      this.#onCursorAdvanced?.(applied.cursor, batch.schemaEpoch);
      this.emitInvalidations([...applied.invalidations, ...overlayInvalidations(resolved)]);
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
    guard: OnlineOnlyGuard = new OnlineOnlyGuard(),
  ): Promise<ReplicaReadResult> {
    const optimistic = await this.intents.overlayMutations(request.shapeId, request.entity);
    return this.worker.read(request, optimistic, guard);
  }

  /** Clone-safe equivalent used by the shell's MessagePort transport. */
  async readWire(request: ReplicaReadRequest): Promise<ReplicaReadWireResult> {
    const optimistic = await this.intents.overlayMutations(request.shapeId, request.entity);
    return this.worker.readWire(request, optimistic);
  }

  /** Clone-safe local search used by the shell's MessagePort transport. */
  async searchWire(request: ReplicaSearchRequest): Promise<ReplicaSearchWireResult> {
    const optimistic = await this.intents.overlayMutations(request.shapeId, request.entity);
    return this.worker.searchWire(request, optimistic);
  }

  liveRead(request: ReplicaReadRequest): LiveQuery<ReplicaReadResult> {
    return this.#live.track(
      new LiveQuery(async (signal) => {
        if (signal.aborted) throw signal.reason;
        const value = await this.read(request);
        return { value, dependencies: [value.dependency] };
      }),
    );
  }

  async enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent> {
    const intent = await this.intents.enqueue(input);
    this.emitInvalidations(overlayInvalidations([intent]));
    return intent;
  }

  claimNextIntent(): Promise<ReplicaIntent | undefined> {
    return this.intents.claimNext();
  }

  markIntentTransportFailed(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.intents.transportFailed(intentId, reason);
  }

  markIntentAwaitingChange(intentId: string): Promise<ReplicaIntent> {
    return this.intents.awaitingChange(intentId);
  }

  async applyIntentOutcome(outcome: IntentOutcome): Promise<ReplicaIntent | undefined> {
    const [intent] = await this.intents.applyOutcomes([outcome]);
    if (intent) this.emitInvalidations(overlayInvalidations([intent]));
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

  subscribeInvalidations(
    listener: (invalidations: readonly ReplicaInvalidation[]) => void,
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
    this.emitInvalidations([{ shapeId: '*', entity: '*', source: 'purge' }]);
    this.#invalidationListeners.clear();
    this.#live.dispose();
    await Promise.all([this.worker.purge(), this.intents.purge()]);
  }

  private readonly onFeedMessage = (message: VaultChangeMessage): void => {
    if (message.type === 'centraid:vault-rebootstrap') {
      void this.requireRebootstrap(message.detail);
      return;
    }
    const cursor =
      message.type === 'centraid:vault-cursor' ? message.cursor : message.detail.cursor;
    if (!this.#feedTarget || cursorAfter(cursor, this.#feedTarget)) this.#feedTarget = cursor;
    this.startFeedSync();
  };

  private startFeedSync(): void {
    if (this.#feedSync || this.#feedRetryTimer || this.#closed || !this.#feedTarget) return;
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
    const abort = new AbortController();
    this.#feedAbort = abort;
    try {
      while (this.#feedTarget && !abort.signal.aborted) {
        const target = this.#feedTarget;
        const status = await this.worker.status();
        if (!status.cursor) return false;
        if (!cursorAfter(target, status.cursor)) {
          this.clearReachedFeedTarget(status.cursor);
          continue;
        }
        let batch: ReplicaChangeBatch | undefined;
        try {
          batch = await this.#pullChanges(status.cursor, abort.signal);
        } catch (error) {
          if (error instanceof ReplicaRebootstrapRequiredError) {
            await this.requireRebootstrap(error);
            return true;
          }
          throw error;
        }
        if (!batch) return false;
        const cursor = await this.applyChanges(batch);
        this.clearReachedFeedTarget(cursor);
      }
      return abort.signal.aborted || !this.#feedTarget;
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
    this.resetFeedGeneration();
    await this.worker.wipe().catch(() => undefined);
    this.emitInvalidations([{ shapeId: '*', entity: '*', source: 'purge' }]);
    this.#onRebootstrapRequired?.(detail);
  }

  private detachFeed(): void {
    this.resetFeedGeneration();
    this.#unsubscribeFeed?.();
    this.#unsubscribeFeed = undefined;
  }

  private resetFeedGeneration(): void {
    this.#feedAbort?.abort();
    this.#feedAbort = undefined;
    this.#feedTarget = undefined;
    if (this.#feedRetryTimer) clearTimeout(this.#feedRetryTimer);
    this.#feedRetryTimer = undefined;
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

async function openIndexedDb(
  identity: ReplicaIdentity,
  factory: IDBFactory,
): Promise<IntentRecordStore> {
  try {
    return await IndexedDbIntentStore.open(await replicaIntentDatabaseName(identity), factory);
  } catch {
    return new MemoryIntentStore();
  }
}

function overlayInvalidations(intents: ReplicaIntent[]): ReplicaInvalidation[] {
  const values = new Map<string, ReplicaInvalidation>();
  for (const intent of intents) {
    for (const mutation of intent.optimistic) {
      const invalidation: ReplicaInvalidation = {
        shapeId: mutation.shapeId,
        entity: mutation.entity,
        rowId: mutation.rowId,
        source: 'overlay',
        intentId: intent.intentId,
        intentState: intent.state,
      };
      values.set(
        `${invalidation.shapeId}\u0000${invalidation.entity}\u0000${invalidation.rowId}`,
        invalidation,
      );
    }
  }
  return [...values.values()];
}

function cursorAfter(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch !== right.epoch || left.seq > right.seq;
}

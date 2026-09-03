import {
  PENDING_OVERLAY_FIELDS,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";
// governance: allow-repo-hygiene file-size-limit (#419) the native session is one cohesive coordinator wiring store, intent outbox, windowed bootstrap, SSE feed, and AppState drain across a single lifecycle
import {
  authHeaders,
  DEFAULT_REPLICA_PURPOSE,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
  runWindowedBootstrap,
  GatewayClientError,
  IntentQueue,
  postReplicaCheckpoint,
  postReplicaIntent,
  pendingIntentIdFromInput,
  ReplicaCoordinator,
  ReplicaProtocolError,
  ReplicaTransportError,
  prepareReplicaWrite,
  VAULT_HEADER,
} from "@centraid/client/replica/native";
import type {
  EnqueueIntentInput,
  GatewayAuth,
  IntentOutcome,
  ReplicaChangeFeedAdapter,
  ReplicaCursor,
  ReplicaBaseVersion,
  ReplicaDigest,
  ReplicaFetcher,
  ReplicaIdFactory,
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaReadRequest,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaShape,
  ReplicaSqliteDriver,
  ReplicaStatus,
  PreparedReplicaWrite,
  ReplicaValue,
  ReplicaWriteMutationInput,
} from "@centraid/client/replica/native";
import { appActionPath } from "@centraid/core/protocol";

import { backoffSchedule } from "../backoff";
import type { BackoffSchedule } from "../backoff";
import { MobileIntentIds } from "./mobile-intent-id";
import type { MountedReadResult } from "./mounted-read-scoping";
import { NativeReplicaStore } from "./native-replica-store";
import { isReplicaStorageFullError } from "./replica-storage-error";
import { noteResyncVerdict } from "./resync-notice";
import { SqliteIntentStore } from "./sqlite-intent-store";
import type { NativeIntentAttention } from "./sqlite-intent-store";
import { stewardDeviceLabel } from "./steward-label";
import type { MountedSteward } from "./steward-label";

export type NativeReadRequest = Omit<ReplicaReadRequest, "shapeId"> & {
  shapeId?: string;
};
export type NativeSearchRequest = Omit<ReplicaSearchRequest, "shapeId"> & {
  shapeId?: string;
};

export type NativeOptimisticMutation = ReplicaWriteMutationInput;

export interface NativeWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: NativeOptimisticMutation[];
  intentId?: string;
  baseVersions?: ReplicaBaseVersion[];
  onlineOnly?: boolean;
}

export type NativeWriteResult =
  | IntentOutcome
  | { intentId: string; status: "queued" | "in-flight"; reason?: string };

export interface MobileReplicaSession {
  read: (
    appId: string,
    request: NativeReadRequest
  ) => Promise<MountedReadResult>;
  search: (
    appId: string,
    request: NativeSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
  write: (appId: string, input: NativeWriteInput) => Promise<NativeWriteResult>;
  revisePendingWrite?: (
    intentId: string,
    revision: ReplicaValue
  ) => Promise<NativeWriteResult | undefined>;
  writeTo?: (
    vaultId: string,
    appId: string,
    input: NativeWriteInput
  ) => Promise<NativeWriteResult>;
  subscribe: (
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ) => () => void;
  pullNow: () => Promise<void | boolean>;
}

export interface AppStateLike {
  readonly currentState: string | null;
  addEventListener: (
    type: "change",
    handler: (state: string) => void
  ) => { remove: () => void };
}

export interface NativeChangeFeed extends ReplicaChangeFeedAdapter {
  setActive: (active: boolean) => void;
}

export interface CreateNativeReplicaSessionOptions {
  gatewayAuth: GatewayAuth;
  fetcher: ReplicaFetcher;
  changeFeed: NativeChangeFeed;
  driver: ReplicaSqliteDriver;
  appState?: AppStateLike;
  isConnected?: () => boolean;
  isNetworkWorkAllowed?: () => Promise<boolean>;
  isRowSyncAllowed?: () => Promise<boolean>;
  retryDelayMs?: number;
  digest?: ReplicaDigest;
  idFactory?: ReplicaIdFactory;
  bootstrapWindow?: number;
  progressiveBootstrap?: boolean;
  onBootstrapProgress?: (progress: {
    phase: "first-page" | "backfill" | "complete";
    pages: number;
  }) => void;
  onStorageFull?: (error: unknown) => void;
  onGatewayOutcome?: (reachable: boolean) => void;
  steward?: MountedSteward;
}

const MAX_INTENT_RETRY_DELAY_MS = 5 * 60_000;

export const NOT_YET_SYNCED =
  "Saved on this phone; it appears here once this vault finishes its first sync.";

interface Waiter {
  resolve: (result: NativeWriteResult) => void;
  reject: (error: unknown) => void;
}

export class NativeReplicaSession implements MobileReplicaSession {
  readonly #coordinator: ReplicaCoordinator;
  readonly #gatewayAuth: GatewayAuth;
  readonly #fetcher: ReplicaFetcher;
  readonly #feed: NativeChangeFeed;
  readonly #appState: AppStateLike | undefined;
  readonly #isConnected: () => boolean;
  readonly #retryBackoff: BackoffSchedule;
  readonly #bootstrapBackoff: BackoffSchedule;
  readonly #isNetworkWorkAllowed: () => Promise<boolean>;
  readonly #isRowSyncAllowed: () => Promise<boolean>;
  readonly #bootstrapWindow: number | undefined;
  readonly #progressiveBootstrap: boolean;
  readonly #intentStore: SqliteIntentStore;
  readonly #intentIds: MobileIntentIds;
  readonly #onBootstrapProgress:
    | CreateNativeReplicaSessionOptions["onBootstrapProgress"]
    | undefined;
  readonly #stewardLabel: string | undefined;
  readonly #onGatewayOutcome: ((reachable: boolean) => void) | undefined;
  #previewReady:
    | { resolve: () => void; reject: (error: unknown) => void }
    | undefined;
  readonly #waiters = new Map<string, Set<Waiter>>();
  #catalog: ReplicaShape[] = [];
  #hasCursor = false;
  #bootstrapPromise: Promise<void> | undefined;
  #bootstrapAbort: AbortController | undefined;
  #drainPromise: Promise<void> | undefined;
  #drainRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #bootstrapRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #appStateSub: { remove: () => void } | undefined;
  #closed = false;

  constructor(
    coordinator: ReplicaCoordinator,
    intentStore: SqliteIntentStore,
    options: Pick<
      CreateNativeReplicaSessionOptions,
      | "gatewayAuth"
      | "fetcher"
      | "changeFeed"
      | "appState"
      | "isConnected"
      | "isNetworkWorkAllowed"
      | "isRowSyncAllowed"
      | "retryDelayMs"
      | "bootstrapWindow"
      | "progressiveBootstrap"
      | "onBootstrapProgress"
      | "onGatewayOutcome"
      | "steward"
    > & { idFactory: ReplicaIdFactory }
  ) {
    this.#coordinator = coordinator;
    this.#intentStore = intentStore;
    this.#gatewayAuth = options.gatewayAuth;
    this.#fetcher = options.fetcher;
    this.#feed = options.changeFeed;
    this.#appState = options.appState;
    this.#isConnected = options.isConnected ?? (() => true);
    this.#isNetworkWorkAllowed =
      options.isNetworkWorkAllowed ?? (() => Promise.resolve(true));
    this.#isRowSyncAllowed =
      options.isRowSyncAllowed ?? this.#isNetworkWorkAllowed;
    const baseMs = options.retryDelayMs ?? 2_000;
    this.#retryBackoff = backoffSchedule({
      baseMs,
      maxMs: Math.max(baseMs, MAX_INTENT_RETRY_DELAY_MS),
      jitter: 0.2,
    });
    this.#bootstrapBackoff = backoffSchedule({
      baseMs,
      maxMs: Math.max(baseMs, MAX_INTENT_RETRY_DELAY_MS),
      jitter: 0.2,
    });
    this.#intentIds = new MobileIntentIds(options.idFactory);
    this.#bootstrapWindow = options.bootstrapWindow;
    this.#progressiveBootstrap = options.progressiveBootstrap ?? false;
    this.#onBootstrapProgress = options.onBootstrapProgress;
    this.#onGatewayOutcome = options.onGatewayOutcome;
    this.#stewardLabel = options.steward
      ? stewardDeviceLabel(options.steward.displayName)
      : undefined;
  }

  get coordinator(): ReplicaCoordinator {
    return this.#coordinator;
  }

  get storageFull(): boolean {
    return this.#coordinator.storageFull;
  }

  resumeAfterStorageFull(): void {
    this.#coordinator.resumeAfterStorageFull();
  }

  async start(): Promise<this> {
    const status = await this.#coordinator.status();
    await this.#coordinator.recoverSending();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) {
      this.#catalog = await this.#coordinator.catalog();
      await this.backfillDeferredProjections();
    }
    if (
      (status.coverage === "partial" ||
        (status.cursor === null && status.coverage !== "complete")) &&
      this.#isConnected() &&
      (await this.#isRowSyncAllowed())
    ) {
      const preview = new Promise<void>((resolve, reject) => {
        this.#previewReady = { resolve, reject };
      });
      const bootstrap = this.bootstrapWhenReachable().catch((error) => {
        this.#previewReady?.reject(error);
        this.#previewReady = undefined;
        throw error;
      });
      if (this.#progressiveBootstrap) {
        void bootstrap.catch(() => undefined);
        await preview;
      } else {
        await bootstrap;
      }
    }
    const foreground = this.#appState
      ? this.#appState.currentState !== "background"
      : true;
    this.#feed.setActive(foreground);
    if (this.#appState) {
      this.#appStateSub = this.#appState.addEventListener(
        "change",
        this.onAppStateChange
      );
    }
    void this.flushIntents();
    return this;
  }

  async read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(
      appId,
      request.entity,
      request.shapeId,
      request.purpose
    );
    return this.#coordinator.readWire({ ...request, shapeId });
  }

  async search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(
      appId,
      request.entity,
      request.shapeId,
      request.purpose
    );
    return this.#coordinator.searchWire({ ...request, shapeId });
  }

  async write(
    appId: string,
    input: NativeWriteInput
  ): Promise<NativeWriteResult> {
    this.assertOpen();
    if (!input.action)
      throw new ReplicaProtocolError("Replica action is required");
    if (input.onlineOnly === true) return this.postAction(appId, input);
    const retainedIntent = pendingIntentIdFromInput(
      appId,
      input.action,
      input.input
    );
    if (retainedIntent) {
      const revised = await this.revisePendingWrite(
        retainedIntent.intentId,
        input.input,
        retainedIntent.expectedActions
      );
      if (revised) return revised;
      throw new ReplicaProtocolError(
        "The pending row is no longer available to edit"
      );
    }
    const intentId = this.#intentIds.forWrite(
      appId,
      input.action,
      input.input,
      input.intentId
    );
    const projected = projectPendingWrite(pendingProjectionFor(appId), {
      appId,
      action: input.action,
      input: input.input as Readonly<Record<string, unknown>>,
      intentId,
    });
    const deferred = this.#catalog.length === 0;
    const { optimistic, dependencies } = deferred
      ? { optimistic: [], dependencies: [] }
      : this.stamped(
          prepareReplicaWrite(
            appId,
            input.optimistic ?? projected.optimistic,
            this.#catalog,
            this.resolveShapeId.bind(this),
            false
          )
        );
    const baseVersions =
      input.baseVersions ??
      projected.baseVersions ??
      (this.#hasCursor
        ? await this.#coordinator.captureBaseVersions(optimistic)
        : []);
    const matched = await this.#coordinator.reviseIntentForProjection(
      appId,
      input.action,
      input.input,
      optimistic,
      baseVersions
    );
    if (matched) {
      this.#intentStore.dismissAttention(matched.supersededIntentId);
      return this.replacementAdmission(matched.replacement);
    }
    const intent = await this.#coordinator.enqueue({
      intentId,
      appId,
      action: input.action,
      input: input.input,
      optimistic,
      dependencies,
      ...(baseVersions.length > 0 ? { baseVersions } : {}),
    } satisfies EnqueueIntentInput);
    if (deferred) await this.markDeferred(intent);
    const settled = terminalResult(intent);
    if (settled) return settled;
    if (!this.#isConnected()) {
      return {
        intentId: intent.intentId,
        status: "queued",
        reason: deferred ? NOT_YET_SYNCED : "waiting for a connection",
      };
    }
    const admitted = new Promise<NativeWriteResult>((resolve, reject) => {
      const waiters = this.#waiters.get(intent.intentId) ?? new Set<Waiter>();
      waiters.add({ resolve, reject });
      this.#waiters.set(intent.intentId, waiters);
    });
    void this.flushIntents();
    return admitted;
  }

  private stamped(prepared: PreparedReplicaWrite): PreparedReplicaWrite {
    const steward = this.#stewardLabel;
    if (steward === undefined) return prepared;
    return {
      ...prepared,
      optimistic: prepared.optimistic.map((mutation) =>
        mutation.op === "upsert"
          ? {
              ...mutation,
              values: {
                ...mutation.values,
                [PENDING_OVERLAY_FIELDS.steward]: steward,
              },
            }
          : mutation
      ),
    };
  }

  private async markDeferred(intent: ReplicaIntent): Promise<void> {
    await this.#intentStore
      .transition(intent.intentId, [intent.state], { reason: NOT_YET_SYNCED })
      .catch(() => undefined);
  }

  private async backfillDeferredProjections(): Promise<void> {
    if (this.#catalog.length === 0) return;
    const pending = await this.#coordinator.pendingIntents();
    for (const intent of pending) {
      if (intent.optimistic.length > 0 || intent.state === "executed") continue;
      const projected = projectPendingWrite(
        pendingProjectionFor(intent.appId),
        {
          appId: intent.appId,
          action: intent.action,
          input: intent.input as Readonly<Record<string, unknown>>,
          intentId: intent.intentId,
        }
      );
      if (projected.optimistic.length === 0) continue;
      let prepared: PreparedReplicaWrite;
      try {
        prepared = this.stamped(
          prepareReplicaWrite(
            intent.appId,
            projected.optimistic,
            this.#catalog,
            this.resolveShapeId.bind(this),
            false
          )
        );
      } catch {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await this.#intentStore
        .transition(intent.intentId, [intent.state], {
          optimistic: prepared.optimistic,
          dependencies: prepared.dependencies,
          ...(intent.reason === NOT_YET_SYNCED ? { reason: undefined } : {}),
        })
        .catch(() => undefined);
    }
  }

  private async postAction(
    appId: string,
    input: NativeWriteInput
  ): Promise<NativeWriteResult> {
    const scope = this.#gatewayAuth.vaultId;
    const response = await this.#fetcher(
      this.#gatewayAuth.baseUrl,
      appActionPath(appId, input.action),
      {
        method: "POST",
        headers: {
          ...authHeaders(this.#gatewayAuth.token, "application/json"),
          ...(scope ? { [VAULT_HEADER]: scope } : {}),
        },
        body: JSON.stringify({ input: input.input }),
        cache: "no-store",
      }
    );
    if (!response.ok) {
      throw new ReplicaProtocolError(
        `${appId}.${input.action} was refused by the gateway (HTTP ${response.status})`
      );
    }
    const output = (await response.json()) as ReplicaValue;
    return {
      intentId: `online-only:${appId}:${input.action}`,
      status: "executed",
      output,
    };
  }

  subscribe(
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    this.assertOpen();
    return this.#coordinator.subscribeInvalidations((invalidations) => {
      const appShapes = new Set(
        this.#catalog
          .filter((shape) => shape.appId === appId)
          .map((shape) => shape.shapeId)
      );
      const relevant = invalidations.filter(
        (invalidation) =>
          invalidation.source === "purge" || appShapes.has(invalidation.shapeId)
      );
      if (relevant.length > 0)
        listener(relevant.map((entry) => ({ ...entry })));
    });
  }

  status(): Promise<ReplicaStatus> {
    return this.#coordinator.status();
  }

  async pendingChanges(): Promise<
    Array<
      | {
          intentId: string;
          status:
            | "queued"
            | "sending"
            | "awaiting-change"
            | "parked"
            | "denied"
            | "conflict"
            | "failed";
          appId: string;
          action: string;
          reason?: string;
          attempts: number;
          enqueuedAt?: string;
          expectedVersion?: number;
          actualVersion?: number;
        }
      | NativeIntentAttention
    >
  > {
    const pending = await this.#coordinator.pendingIntents();
    const enqueuedTimes = this.#intentStore.enqueuedTimes();
    const retained = pending.flatMap((intent) => {
      const enqueuedAt = enqueuedTimes.get(intent.intentId);
      return intent.state === "executed"
        ? []
        : [
            {
              intentId: intent.intentId,
              status: intent.conflict ? ("conflict" as const) : intent.state,
              appId: intent.appId,
              action: intent.action,
              ...(intent.reason ? { reason: intent.reason } : {}),
              attempts: intent.attempts,
              ...(enqueuedAt ? { enqueuedAt } : {}),
              ...(intent.conflict
                ? {
                    expectedVersion: intent.conflict.expectedVersion,
                    actualVersion: intent.conflict.actualVersion,
                  }
                : {}),
            },
          ];
    });
    const retainedIds = new Set(retained.map((intent) => intent.intentId));
    return [
      ...retained,
      ...this.#intentStore
        .attention()
        .filter((attention) => !retainedIds.has(attention.intentId)),
    ];
  }

  async cancelPendingChange(intentId: string): Promise<boolean> {
    const pending = await this.#coordinator.pendingIntents();
    if (!pending.some((intent) => intent.intentId === intentId)) return false;
    const reason = "Cancelled on this device";
    await this.#coordinator.applyIntentOutcome({
      intentId,
      status: "denied",
      reason,
    });
    await this.#coordinator.discardIntent(intentId);
    this.#intentStore.dismissAttention(intentId);
    this.resolveWaiter(intentId, { intentId, status: "denied", reason });
    return true;
  }

  async discardPendingWrite(intentId: string): Promise<boolean> {
    const discarded = await this.#coordinator.discardIntent(intentId);
    if (discarded) this.#intentStore.dismissAttention(intentId);
    return discarded;
  }

  async revisePendingWrite(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<NativeWriteResult | undefined> {
    const replacement = await this.#coordinator.reviseIntent(
      intentId,
      revision,
      expectedActions
    );
    if (!replacement) return undefined;
    this.#intentStore.dismissAttention(intentId);
    return this.replacementAdmission(replacement);
  }

  private replacementAdmission(replacement: ReplicaIntent): NativeWriteResult {
    if (!this.#isConnected())
      return {
        intentId: replacement.intentId,
        status: "queued",
        reason: "waiting for a connection",
      };
    void this.flushIntents();
    return { intentId: replacement.intentId, status: "in-flight" };
  }

  async retryPendingWrite(
    intentId: string
  ): Promise<NativeWriteResult | undefined> {
    const replacement = await this.#coordinator.retryIntent(intentId);
    if (!replacement) return undefined;
    this.#intentStore.dismissAttention(intentId);
    return this.replacementAdmission(replacement);
  }

  dismissAttention(intentId: string): void {
    this.#intentStore.dismissAttention(intentId);
  }

  catalog(): readonly ReplicaShape[] {
    return this.#catalog;
  }

  notifyReachable(): void {
    if (!this.#isConnected() || this.#closed) return;
    this.resetRetry();
    if (this.#hasCursor) {
      void this.pullNow().catch(() => undefined);
    } else {
      void this.bootstrapWhenReachable().catch(() => undefined);
    }
    void this.flushIntents();
  }

  updateGatewayBase(baseUrl: string): void {
    if (this.#closed || this.#gatewayAuth.baseUrl === baseUrl) return;
    this.#gatewayAuth.baseUrl = baseUrl;
    const foreground = this.#appState
      ? this.#appState.currentState !== "background"
      : true;
    this.#feed.setActive(false);
    if (foreground) this.#feed.setActive(true);
  }

  async flushIntents(): Promise<void> {
    if (this.#closed || !this.#isConnected()) return;
    if (!(await this.#isNetworkWorkAllowed())) {
      this.settleWaitersAsQueued(
        "saved locally; sync is paused on this network"
      );
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

  async pullNow(): Promise<boolean> {
    if (this.#closed || !this.#isConnected() || !this.#hasCursor) return false;
    if (!(await this.#isRowSyncAllowed())) return false;
    const status = await this.#coordinator.status();
    if (!status.cursor) return false;
    const abort = new AbortController();
    const started = Date.now();
    let cursor = status.cursor;
    let batches = 0;
    while (cursor && batches < 32 && Date.now() - started < 5_000) {
      // oxlint-disable-next-line no-await-in-loop
      const batch = await this.pullChanges(cursor, abort.signal);
      if (!batch) break;
      // oxlint-disable-next-line no-await-in-loop
      const next = await this.#coordinator.applyChanges(batch);
      batches += 1;
      const progressed = next.epoch !== cursor.epoch || next.seq > cursor.seq;
      cursor = next;
      if (!progressed || !batch.hasMore) break;
    }
    return true;
  }

  requireBootstrap(detail?: unknown): void {
    if (detail !== undefined)
      noteResyncVerdict(detail, this.#gatewayAuth.vaultId);
    this.#hasCursor = false;
    if (!this.#closed)
      void this.bootstrapWhenReachable().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#bootstrapRetryTimer) clearTimeout(this.#bootstrapRetryTimer);
    this.#bootstrapRetryTimer = undefined;
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.#feed.setActive(false);
    this.rejectWaiters(new ReplicaProtocolError("Replica session closed"));
    this.#bootstrapAbort?.abort();
    await this.#bootstrapPromise?.catch(() => undefined);
    await this.#coordinator.close();
  }

  async purge(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#bootstrapRetryTimer) clearTimeout(this.#bootstrapRetryTimer);
    this.#bootstrapRetryTimer = undefined;
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.#feed.setActive(false);
    this.rejectWaiters(new ReplicaProtocolError("Replica scope was revoked"));
    this.#bootstrapAbort?.abort();
    await this.#bootstrapPromise?.catch(() => undefined);
    await this.#coordinator.purge();
  }

  private readonly onAppStateChange = (state: string): void => {
    if (this.#closed) return;
    if (state === "active") {
      this.resetRetry();
      this.#feed.setActive(true);
      if (this.#hasCursor) {
        void this.pullNow().catch(() => undefined);
      } else {
        void this.bootstrapWhenReachable().catch(() => undefined);
      }
      void this.flushIntents();
    } else if (state === "background") {
      this.#feed.setActive(false);
    }
  };

  private async bootstrapWhenReachable(): Promise<void> {
    if (this.#bootstrapPromise || this.#closed || !this.#isConnected())
      return this.#bootstrapPromise;
    if (!(await this.#isRowSyncAllowed())) return;
    this.#bootstrapPromise = this.bootstrap()
      .then(() => {
        this.#bootstrapBackoff.reset();
      })
      .catch((error: unknown) => {
        this.scheduleBootstrapRetry();
        throw error;
      })
      .finally(() => {
        this.#bootstrapPromise = undefined;
      });
    return this.#bootstrapPromise;
  }

  private scheduleBootstrapRetry(): void {
    if (this.#bootstrapRetryTimer || this.#closed) return;
    this.#bootstrapRetryTimer = setTimeout(() => {
      this.#bootstrapRetryTimer = undefined;
      void this.bootstrapWhenReachable().catch(() => undefined);
    }, this.#bootstrapBackoff.next());
  }

  private async bootstrap(): Promise<void> {
    const abort = new AbortController();
    this.#bootstrapAbort = abort;
    const resolved: IntentOutcome[] = [];
    try {
      await runWindowedBootstrap({
        gatewayAuth: this.#gatewayAuth,
        target: this.#coordinator,
        fetcher: this.#fetcher,
        signal: abort.signal,
        ...(this.#bootstrapWindow === undefined
          ? {}
          : { window: this.#bootstrapWindow }),
        reconcileOutcomes: async (cursor) => {
          const pending = await this.#coordinator.pendingIntents();
          const exact = await fetchReplicaIntentOutcomes(
            this.#gatewayAuth,
            pending.map((intent) => intent.intentId),
            cursor,
            this.#fetcher
          );
          resolved.push(...exact);
          return exact;
        },
        pullChanges: async (cursor, signal) => {
          const shapeIds = (await this.#coordinator.catalog()).map(
            (shape) => shape.shapeId
          );
          return fetchReplicaChanges(
            this.#gatewayAuth,
            cursor,
            signal,
            shapeIds,
            this.#fetcher
          );
        },
        onFirstPage: async () => {
          this.#catalog = await this.#coordinator.catalog();
          await this.backfillDeferredProjections();
          this.#onBootstrapProgress?.({ phase: "first-page", pages: 1 });
          this.#previewReady?.resolve();
          this.#previewReady = undefined;
        },
        onProgress: (pages) => {
          if (pages > 1)
            this.#onBootstrapProgress?.({ phase: "backfill", pages });
        },
      });
    } finally {
      if (this.#bootstrapAbort === abort) this.#bootstrapAbort = undefined;
    }
    this.#hasCursor = true;
    this.#catalog = await this.#coordinator.catalog();
    await this.backfillDeferredProjections();
    this.#onBootstrapProgress?.({ phase: "complete", pages: 0 });
    for (const outcome of resolved)
      this.resolveWaiter(outcome.intentId, outcome);
  }

  private pullChanges = (cursor: ReplicaCursor, signal: AbortSignal) => {
    const shapeIds = this.#catalog.map((shape) => shape.shapeId);
    return fetchReplicaChanges(
      this.#gatewayAuth,
      cursor,
      signal,
      shapeIds,
      this.#fetcher
    );
  };

  private async drainLoop(): Promise<void> {
    const drainNextIntent = async (): Promise<void> => {
      if (this.#closed) return;
      if (!this.#isConnected()) {
        this.settleWaitersAsQueued("waiting for a connection");
        return;
      }
      let intent: ReplicaIntent | undefined;
      try {
        intent = await this.#coordinator.claimNextIntent();
      } catch (error) {
        this.rejectWaiters(error);
        return;
      }
      if (!intent) return;
      try {
        const { outcome } = await postReplicaIntent(
          this.#gatewayAuth,
          intent,
          this.#fetcher
        );
        if (outcome.status === "executed" || outcome.status === "in-flight") {
          await this.#coordinator.markIntentAwaitingChange(intent.intentId);
        } else {
          await this.#coordinator.applyIntentOutcome(outcome);
        }
        this.resolveWaiter(intent.intentId, outcome);
        this.#retryBackoff.reset();
        this.#onGatewayOutcome?.(true);
      } catch (error) {
        if (isAuthorizationError(error)) {
          this.rejectWaiter(intent.intentId, error);
          this.settleWaitersAsQueued(
            "saved locally; the session is reconnecting"
          );
          this.requireBootstrap();
          return;
        }
        if (isPermanentIntentRejection(error)) {
          const outcome: IntentOutcome = {
            intentId: intent.intentId,
            status: error.status === 403 ? "denied" : "failed",
            reason: error.message,
          };
          await this.#coordinator.applyIntentOutcome(outcome);
          this.resolveWaiter(intent.intentId, outcome);
          return drainNextIntent();
        }
        this.#onGatewayOutcome?.(false);
        await this.#coordinator
          .markIntentTransportFailed(intent.intentId, errorMessage(error))
          .catch(() => undefined);
        const queuedReason =
          "saved locally; retrying when the gateway is reachable";
        this.resolveWaiter(intent.intentId, {
          intentId: intent.intentId,
          status: "queued",
          reason: queuedReason,
        });
        this.settleWaitersAsQueued(queuedReason);
        this.scheduleRetry();
        return;
      }
      return drainNextIntent();
    };
    return drainNextIntent();
  }

  private scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushIntents();
    }, this.#retryBackoff.next());
  }

  private resetRetry(): void {
    this.#retryBackoff.reset();
    this.#bootstrapBackoff.reset();
    if (this.#bootstrapRetryTimer) {
      clearTimeout(this.#bootstrapRetryTimer);
      this.#bootstrapRetryTimer = undefined;
    }
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  private resolveWaiter(intentId: string, result: NativeWriteResult): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    for (const waiter of waiters)
      waiter.resolve({ ...result } as NativeWriteResult);
  }

  private rejectWaiter(intentId: string, error: unknown): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    for (const waiter of waiters) waiter.reject(error);
  }

  private settleWaitersAsQueued(reason: string): void {
    for (const intentId of Array.from(this.#waiters.keys()))
      this.resolveWaiter(intentId, { intentId, status: "queued", reason });
  }

  private rejectWaiters(error: unknown): void {
    const intentIds = Array.from(this.#waiters.keys());
    for (const intentId of intentIds) this.rejectWaiter(intentId, error);
  }

  private resolveShapeId(
    appId: string,
    entity: string,
    requested?: string,
    purpose?: string
  ): string {
    const resolvedPurpose =
      purpose ?? (requested ? undefined : DEFAULT_REPLICA_PURPOSE);
    const candidates = this.#catalog.filter(
      (shape) =>
        shape.appId === appId &&
        (resolvedPurpose === undefined || shape.purpose === resolvedPurpose) &&
        shape.entities.some((item) => item.entity === entity)
    );
    if (requested) {
      if (!candidates.some((shape) => shape.shapeId === requested)) {
        throw new ReplicaProtocolError(
          `Shape ${requested} is not available to app ${appId}`
        );
      }
      return requested;
    }
    if (candidates.length !== 1) {
      throw new ReplicaProtocolError(
        candidates.length === 0
          ? `No offline shape for ${appId}/${entity}`
          : `Multiple offline shapes match ${appId}/${entity}; shapeId is required`
      );
    }
    return candidates[0]!.shapeId;
  }

  private assertOpen(): void {
    if (this.#closed)
      throw new ReplicaProtocolError("Replica session is closed");
  }
}

export async function createNativeReplicaSession(
  options: CreateNativeReplicaSessionOptions
): Promise<NativeReplicaSession> {
  if (!options.gatewayAuth.vaultId) {
    throw new ReplicaProtocolError("An addressed vault is required");
  }
  const fetcher = options.fetcher;
  const store = NativeReplicaStore.create(
    options.driver,
    options.gatewayAuth.vaultId
  );
  const intentStore = SqliteIntentStore.create(options.driver);
  const feed = options.changeFeed;
  let digest = options.digest;
  let idFactory = options.idFactory;
  if (!digest || !idFactory) {
    const { nativeReplicaDigest, nativeReplicaIdFactory } =
      await import("./native-hash");
    digest ??= nativeReplicaDigest;
    idFactory ??= nativeReplicaIdFactory;
  }
  const intents = new IntentQueue(intentStore, {
    digest,
    idFactory,
    onSupersededRetired: (intentId) => intentStore.dismissAttention(intentId),
  });
  let session: NativeReplicaSession | undefined = undefined;
  const coordinator = new ReplicaCoordinator(store, intents, {
    changeFeed: feed,
    pullChanges: (cursor, signal) => {
      const shapeIds = (session?.catalog() ?? []).map((shape) => shape.shapeId);
      return fetchReplicaChanges(
        options.gatewayAuth,
        cursor,
        signal,
        shapeIds,
        fetcher
      );
    },
    onCursorAdvanced: (cursor, schemaEpoch) => {
      void postReplicaCheckpoint(
        options.gatewayAuth,
        cursor,
        schemaEpoch,
        fetcher
      ).catch(() => undefined);
    },
    onRebootstrapRequired: (detail) => session?.requireBootstrap(detail),
    isStorageFull: isReplicaStorageFullError,
    onStorageFull: (error) => options.onStorageFull?.(error),
  });
  session = new NativeReplicaSession(coordinator, intentStore, {
    ...options,
    fetcher,
    idFactory,
  });
  await session.start();
  return session;
}

function terminalResult(intent: ReplicaIntent): NativeWriteResult | undefined {
  if (intent.state === "awaiting-change")
    return { intentId: intent.intentId, status: "in-flight" };
  if (
    intent.state !== "parked" &&
    intent.state !== "executed" &&
    intent.state !== "denied" &&
    intent.state !== "failed"
  ) {
    return undefined;
  }
  return {
    intentId: intent.intentId,
    status: intent.conflict ? "conflict" : intent.state,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.output === undefined ? {} : { output: intent.output }),
    ...(intent.conflict === undefined ? {} : { conflict: intent.conflict }),
  };
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === "auth_required";
}

function isPermanentIntentRejection(
  error: unknown
): error is ReplicaTransportError {
  return (
    error instanceof ReplicaTransportError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

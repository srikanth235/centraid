// governance: allow-repo-hygiene file-size-limit (#406) shell session keeps replica ownership, lifecycle teardown, and intent drain in one auditable boundary
import {
  auth,
  doFetch,
  GatewayClientError,
  VAULT_HEADER,
} from "../gateway-client-core.js";
import type { GatewayAuth } from "../gateway-client-core.js";
import { vaultStatus } from "../gateway-client-vault.js";
import {
  resumeVaultChanges,
  setVaultChangeShapeIds,
  subscribeVaultChanges,
  clearVaultChangeCursor,
} from "../vault-change-feed.js";
import { createReplicaCoordinator } from "./coordinator-web.js";
import type { ReplicaWebCoordinatorOptions } from "./coordinator-web.js";
import { ReplicaProtocolError } from "./errors.js";
import type {
  PendingIntentReplacement,
  PendingIntentRevisionTarget,
} from "./intent-revision.js";
import {
  fetchReplicaBootstrap,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
  postReplicaCheckpoint,
  postReplicaIntent,
  ReplicaTransportError,
} from "./shell-transport.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import {
  deferTerminalReplicaPurge,
  markReplicaIdentityTerminal,
  prepareRememberedReplicaIdentity,
  purgeReplicaIdentityStorage,
  purgeRememberedReplicaIdentities,
  unregisterRememberedReplicaIdentity,
} from "./storage-manifest.js";
import type { ReplicaIdentityInventory } from "./storage-manifest.js";
import type {
  ReplicaBootstrapAdvance,
  ReplicaBootstrapResume,
} from "./store-core.js";
import { TerminalReplicaPurgeRetryLoop } from "./terminal-purge-retry.js";
import { DEFAULT_REPLICA_PURPOSE } from "./types.js";
import type {
  EnqueueIntentInput,
  IntentOutcome,
  OptimisticMutation,
  ReplicaBootstrapHeader,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaBaseVersion,
  ReplicaDependency,
  ReplicaIdentity,
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaReadRequest,
  ReplicaReadWireResult,
  ReplicaSnapshotRow,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaShape,
  ReplicaStatus,
  ReplicaValue,
} from "./types.js";
import { runWindowedBootstrap } from "./windowed-bootstrap.js";
import { prepareReplicaWrite } from "./write-helpers.js";
import type { ReplicaWriteMutationInput } from "./write-helpers.js";

/** Teardown mutates shared ownership — finish each scope before the next. */
function applyScopeTeardownsInOrder<T>(
  values: Iterable<T>,
  teardown: (value: T) => void | PromiseLike<void>
): Promise<void> {
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => teardown(value)),
    Promise.resolve()
  );
}

export type ShellReplicaReadRequest = Omit<ReplicaReadRequest, "shapeId"> & {
  shapeId?: string;
};

export type ShellReplicaSearchRequest = Omit<
  ReplicaSearchRequest,
  "shapeId"
> & {
  shapeId?: string;
};

export type ShellOptimisticMutation = ReplicaWriteMutationInput;

export interface ShellReplicaWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: ShellOptimisticMutation[];
  intentId?: string;
  baseVersions?: ReplicaBaseVersion[];
}

export type ShellReplicaWriteResult =
  | IntentOutcome
  | { intentId: string; status: "queued" | "in-flight"; reason?: string };

export interface ShellReplicaCoordinator {
  bootstrap: (
    snapshot: Awaited<ReturnType<typeof fetchReplicaBootstrap>>
  ) => Promise<ReplicaCursor>;
  bootstrapBegin?: (
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ) => Promise<ReplicaBootstrapResume | undefined>;
  bootstrapPage?: (
    rows: ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ) => Promise<void>;
  bootstrapPreview?: (cursor: ReplicaCursor) => Promise<void>;
  bootstrapCommit?: (
    cursor: ReplicaCursor,
    header: ReplicaBootstrapHeader,
    outcomes?: IntentOutcome[]
  ) => Promise<ReplicaCursor>;
  applyChanges?: (batch: ReplicaChangeBatch) => Promise<ReplicaCursor>;
  status: () => Promise<ReplicaStatus>;
  catalog: () => Promise<ReplicaShape[]>;
  readWire: (request: ReplicaReadRequest) => Promise<ReplicaReadWireResult>;
  searchWire: (
    request: ReplicaSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
  enqueue: (input: EnqueueIntentInput) => Promise<ReplicaIntent>;
  /** The queued intent this write revises, by the row id it names (#922 G2). */
  pendingIntentForInput?: (
    appId: string,
    action: string,
    input: ReplicaValue
  ) => Promise<PendingIntentRevisionTarget | undefined>;
  captureBaseVersions?: (
    mutations: readonly OptimisticMutation[]
  ) => Promise<ReplicaBaseVersion[]>;
  claimNextIntent: () => Promise<ReplicaIntent | undefined>;
  markIntentTransportFailed: (
    intentId: string,
    reason?: string
  ) => Promise<ReplicaIntent>;
  markIntentAwaitingChange: (intentId: string) => Promise<ReplicaIntent>;
  applyIntentOutcome: (
    outcome: IntentOutcome
  ) => Promise<ReplicaIntent | undefined>;
  recoverSending: () => Promise<ReplicaIntent[]>;
  pendingIntents: () => Promise<ReplicaIntent[]>;
  discardIntent: (intentId: string) => Promise<boolean>;
  retryIntent: (intentId: string) => Promise<ReplicaIntent | undefined>;
  reviseIntent?: (
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ) => Promise<ReplicaIntent | undefined>;
  reviseIntentForProjection?: (
    appId: string,
    action: string,
    revision: ReplicaValue,
    optimistic: readonly OptimisticMutation[],
    refreshedBaseVersions?: ReplicaBaseVersion[]
  ) => Promise<PendingIntentReplacement | undefined>;
  subscribeInvalidations: (
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ) => () => void;
  /** Optional so bootstrap-only coordinators stay valid implementations. */
  syncNow?: () => Promise<void>;
  close: () => Promise<void>;
  purge: () => Promise<void>;
}

export interface ReplicaShellSessionOptions {
  fetcher?: ReplicaFetcher;
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  isOnline?: () => boolean;
  retryDelayMs?: number;
  indexedDbFactory?: IDBFactory;
  rememberStorage?: boolean;
  inventory?: ReplicaIdentityInventory;
  onAuthorizationRevoked?: (session: ReplicaShellSession) => void;
  pollIntervalMs?: number;
}

export interface OpenReplicaShellSessionOptions extends ReplicaShellSessionOptions {
  workerFactory?: ReplicaWebCoordinatorOptions["workerFactory"];
  intentStore?: ReplicaWebCoordinatorOptions["intentStore"];
  idFactory?: () => string;
}

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
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #catalog: ReplicaShape[] = [];
  #bootstrapPromise: Promise<void> | undefined;
  #bootstrapAbort: AbortController | undefined;
  #bootstrapRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #bootstrapRetryAttempt = 0;
  #rebootstrapQueued = false;
  #drainPromise: Promise<void> | undefined;
  #drainRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #admissionWaiters = new Map<
    string,
    Set<{
      resolve: (result: ShellReplicaWriteResult) => void;
      reject: (error: unknown) => void;
    }>
  >();
  #admissionRegistrations = 0;
  #admissionRegistrationBarrier: Promise<void> | undefined;
  #releaseAdmissionRegistrationBarrier: (() => void) | undefined;
  #hasCursor = false;
  #closed = false;

  constructor(
    readonly gatewayAuth: GatewayAuth,
    readonly coordinator: ShellReplicaCoordinator,
    options: ReplicaShellSessionOptions = {}
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
  }

  async start(status: ReplicaStatus): Promise<this> {
    this.#eventTarget.addEventListener("online", this.onOnline);
    await this.coordinator.recoverSending();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) this.#catalog = await this.coordinator.catalog();
    // COMPAT(replica-coordinator-v1): added 2026-08-02, drop when floor >= replica-windowed-v1.
    // Older coordinator implementations did not report coverage. A non-null
    // cursor from those implementations is the only available proof and must
    // remain usable; current stores always populate the explicit field.
    if (
      status.coverage === "partial" ||
      (status.cursor === null && status.coverage !== "complete")
    ) {
      if (this.#isOnline()) await this.bootstrapWhenReachable();
      else this.#catalog = await this.coordinator.catalog();
    }
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

  async read(
    appId: string,
    request: ShellReplicaReadRequest
  ): Promise<ReplicaReadWireResult> {
    this.assertOpen();
    const shapeIdLocal = this.resolveShapeId(
      appId,
      request.entity,
      request.shapeId,
      request.purpose
    );
    return this.coordinator.readWire({ ...request, shapeId: shapeIdLocal });
  }

  async search(
    appId: string,
    request: ShellReplicaSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const shapeIdLocal = this.resolveShapeId(
      appId,
      request.entity,
      request.shapeId,
      request.purpose
    );
    return this.coordinator.searchWire({ ...request, shapeId: shapeIdLocal });
  }

  async write(
    appId: string,
    input: ShellReplicaWriteInput
  ): Promise<ShellReplicaWriteResult> {
    this.assertOpen();
    if (!input.action)
      throw new ReplicaProtocolError("Replica action is required");
    const retainedIntent = await this.coordinator.pendingIntentForInput?.(
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
    // Offline first-open has no catalog; the intent is still durable.
    const { optimistic, dependencies } =
      this.#catalog.length === 0
        ? { optimistic: [], dependencies: [] }
        : prepareReplicaWrite(
            appId,
            input.optimistic,
            this.#catalog,
            this.resolveShapeId.bind(this),
            false
          );
    const baseVersions =
      input.baseVersions ??
      (this.#hasCursor
        ? await this.coordinator.captureBaseVersions?.(optimistic)
        : undefined) ??
      [];
    const matched = await this.coordinator.reviseIntentForProjection?.(
      appId,
      input.action,
      input.input,
      optimistic,
      baseVersions
    );
    if (matched) return this.replacementAdmission(matched.replacement);
    this.beginAdmissionRegistration();
    try {
      const intent = await this.coordinator.enqueue({
        ...(input.intentId ? { intentId: input.intentId } : {}),
        appId,
        action: input.action,
        input: input.input,
        optimistic,
        dependencies,
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      });
      this.assertOpen();
      const existingAdmission = admissionResult(intent);
      if (existingAdmission) return existingAdmission;
      if (!this.#isOnline()) {
        return {
          intentId: intent.intentId,
          status: "queued",
          reason: "waiting for a connection",
        };
      }
      const admitted = new Promise<ShellReplicaWriteResult>(
        (resolve, reject) => {
          const waiters =
            this.#admissionWaiters.get(intent.intentId) ?? new Set();
          waiters.add({ resolve, reject });
          this.#admissionWaiters.set(intent.intentId, waiters);
        }
      );
      void this.flushIntents();
      return admitted;
    } finally {
      this.finishAdmissionRegistration();
    }
  }

  discardPendingWrite(intentId: string): Promise<boolean> {
    this.assertOpen();
    return this.coordinator.discardIntent(intentId);
  }

  async revisePendingWrite(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<ShellReplicaWriteResult | undefined> {
    this.assertOpen();
    const replacement = await this.coordinator.reviseIntent?.(
      intentId,
      revision,
      expectedActions
    );
    if (!replacement) return undefined;
    return this.replacementAdmission(replacement);
  }

  async retryPendingWrite(
    intentId: string
  ): Promise<ShellReplicaWriteResult | undefined> {
    this.assertOpen();
    const replacement = await this.coordinator.retryIntent(intentId);
    if (!replacement) return undefined;
    if (!this.#isOnline())
      return {
        intentId: replacement.intentId,
        status: "queued",
        reason: "waiting for a connection",
      };
    void this.flushIntents();
    return { intentId: replacement.intentId, status: "in-flight" };
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

  subscribe(
    appId: string,
    dependencies: ShellReplicaReadRequest[] | ReplicaDependency[] | undefined,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    this.assertOpen();
    const requested = dependencies ?? [];
    const explicitShapes = new Set(
      requested.flatMap((dependency) =>
        dependency.shapeId
          ? [`${dependency.shapeId}\u0000${dependency.entity}`]
          : []
      )
    );
    const wildcardEntities = new Set(
      requested.flatMap((dependency) =>
        dependency.shapeId ? [] : [dependency.entity]
      )
    );
    return this.coordinator.subscribeInvalidations((invalidations) => {
      const appShapes = new Set(
        this.#catalog.filter((shape) => shape.appId === appId).map(shapeId)
      );
      const relevant = invalidations.filter(
        (invalidation) =>
          invalidation.source === "purge" ||
          (appShapes.has(invalidation.shapeId) &&
            (requested.length === 0 ||
              wildcardEntities.has(invalidation.entity) ||
              explicitShapes.has(
                `${invalidation.shapeId}\u0000${invalidation.entity}`
              )))
      );
      if (relevant.length > 0) listener(structuredClone(relevant));
    });
  }

  /**
   * Await so a post-write re-read cannot race the SSE nudge and paint
   * pre-write rows. First fill still belongs to the bootstrap walk.
   */
  async sync(): Promise<void> {
    this.assertOpen();
    if (!this.#hasCursor) {
      await this.bootstrapWhenReachable();
      return;
    }
    await this.coordinator.syncNow?.();
  }

  async flushIntents(): Promise<void> {
    if (this.#closed) return;
    if (!this.#isOnline()) {
      this.resolveAdmissionWaitersAsQueued(
        "saved locally; waiting for a connection"
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#bootstrapAbort?.abort();
    this.rejectAdmissionWaiters(
      new ReplicaProtocolError("Replica session closed")
    );
    this.detach();
    await this.coordinator.close();
  }

  async purge(): Promise<void> {
    clearVaultChangeCursor(this.gatewayAuth);
    const identity = replicaIdentityForGatewayAuth(this.gatewayAuth);
    const inventoryOptions = {
      ...(this.#indexedDbFactory
        ? { indexedDbFactory: this.#indexedDbFactory }
        : {}),
      ...(this.#inventory ? { inventory: this.#inventory } : {}),
    };
    if (this.#closed) {
      if (this.#rememberStorage)
        await purgeReplicaIdentityStorage(identity, inventoryOptions);
      return;
    }
    this.#closed = true;
    this.#bootstrapAbort?.abort();
    this.rejectAdmissionWaiters(
      new ReplicaProtocolError("Replica session purged")
    );
    this.detach();
    let terminalTracked = false;
    if (this.#rememberStorage) {
      terminalTracked = await markReplicaIdentityTerminal(
        identity,
        inventoryOptions
      );
      if (!terminalTracked) {
        throw new ReplicaProtocolError(
          "Could not durably schedule remembered replica purge"
        );
      }
    }
    try {
      await this.coordinator.purge();
      if (this.#rememberStorage) {
        await unregisterRememberedReplicaIdentity(identity, inventoryOptions);
      }
    } catch (error) {
      if (terminalTracked) {
        await deferTerminalReplicaPurge(identity, inventoryOptions).catch(
          () => undefined
        );
      }
      terminalPurgeRetryLoop.wake();
      throw error;
    }
  }

  requireBootstrap(): void {
    this.#hasCursor = false;
    if (this.#closed) return;
    // An in-flight walk started from older state; queue one follow-up.
    if (this.#bootstrapPromise) {
      this.#rebootstrapQueued = true;
      return;
    }
    void this.bootstrapWhenReachable();
  }

  private async bootstrapWhenReachable(): Promise<void> {
    if (this.#bootstrapPromise || this.#closed || !this.#isOnline())
      return this.#bootstrapPromise;
    this.#bootstrapPromise = this.bootstrap().finally(() => {
      this.#bootstrapPromise = undefined;
      if (!this.#rebootstrapQueued) return;
      this.#rebootstrapQueued = false;
      if (!this.#closed) void this.bootstrapWhenReachable();
    });
    return this.#bootstrapPromise;
  }

  private async bootstrap(): Promise<void> {
    const abort = new AbortController();
    this.#bootstrapAbort = abort;
    try {
      const supportsWindowed = Boolean(
        this.coordinator.bootstrapBegin &&
        this.coordinator.bootstrapPage &&
        this.coordinator.bootstrapPreview &&
        this.coordinator.bootstrapCommit &&
        this.coordinator.applyChanges
      );
      // COMPAT(replica-coordinator-v1): added 2026-08-02, drop when floor >= replica-windowed-v1.
      if (!supportsWindowed) {
        const snapshot = await fetchReplicaBootstrap(
          this.gatewayAuth,
          this.#fetcher
        );
        const pending = await this.coordinator.pendingIntents();
        const exactOutcomes = await fetchReplicaIntentOutcomes(
          this.gatewayAuth,
          pending.map((intent) => intent.intentId),
          snapshot.cursor,
          this.#fetcher
        );
        snapshot.outcomes = mergeIntentOutcomes(
          snapshot.outcomes ?? [],
          exactOutcomes
        );
        await this.coordinator.bootstrap(snapshot);
        this.#hasCursor = true;
        this.#catalog = await this.coordinator.catalog();
        for (const outcome of exactOutcomes)
          this.resolveAdmissionWaiter(outcome.intentId, outcome);
        this.#bootstrapRetryAttempt = 0;
        return;
      }
      const resolved: IntentOutcome[] = [];
      await runWindowedBootstrap({
        gatewayAuth: this.gatewayAuth,
        // Wrap methods — a bare reference binds `this` to this object literal.
        target: {
          bootstrapBegin: (header, begin) =>
            this.coordinator.bootstrapBegin!(header, begin),
          bootstrapPage: (rows, advance) =>
            this.coordinator.bootstrapPage!(rows, advance),
          bootstrapPreview: this.coordinator.bootstrapPreview
            ? (rows) => this.coordinator.bootstrapPreview!(rows)
            : undefined,
          // Forward `outcomes` or in-flight writes across bootstrap stay unresolved.
          bootstrapCommit: (cursor, header, outcomes) =>
            this.coordinator.bootstrapCommit!(cursor, header, outcomes),
          applyChanges: (changes) => this.coordinator.applyChanges!(changes),
        },
        fetcher: this.#fetcher,
        signal: abort.signal,
        reconcileOutcomes: async (cursor) => {
          const pending = await this.coordinator.pendingIntents();
          const exact = await fetchReplicaIntentOutcomes(
            this.gatewayAuth,
            pending.map((intent) => intent.intentId),
            cursor,
            this.#fetcher
          );
          resolved.push(...exact);
          return exact;
        },
        pullChanges: async (cursor, signal) => {
          const shapeIds = (await this.coordinator.catalog()).map(
            (shape) => shape.shapeId
          );
          return fetchReplicaChanges(
            this.gatewayAuth,
            cursor,
            signal,
            shapeIds,
            this.#fetcher
          );
        },
        onFirstPage: async () => {
          this.#catalog = await this.coordinator.catalog();
        },
      });
      this.#hasCursor = true;
      this.#catalog = await this.coordinator.catalog();
      for (const outcome of resolved) {
        this.resolveAdmissionWaiter(outcome.intentId, outcome);
      }
      this.#bootstrapRetryAttempt = 0;
    } catch (error) {
      if (isAuthorizationError(error)) await this.authorizationRevoked();
      else if (isTransientGatewayError(error)) this.scheduleBootstrapRetry();
      else throw error;
    } finally {
      if (this.#bootstrapAbort === abort) this.#bootstrapAbort = undefined;
    }
  }

  private async drainLoop(): Promise<void> {
    if (this.#closed || !this.#isOnline()) return;
    await this.waitForAdmissionRegistrations();
    if (this.#closed) return;
    if (!this.#isOnline()) {
      this.resolveAdmissionWaitersAsQueued(
        "saved locally; waiting for a connection"
      );
      return;
    }
    let intent: ReplicaIntent | undefined;
    try {
      intent = await this.coordinator.claimNextIntent();
    } catch (error) {
      this.rejectAdmissionWaiters(error);
      return;
    }
    if (!intent) return;
    try {
      const { outcome } = await postReplicaIntent(
        this.gatewayAuth,
        intent,
        this.#fetcher
      );
      if (outcome.status === "executed" || outcome.status === "in-flight") {
        await this.coordinator.markIntentAwaitingChange(intent.intentId);
      } else {
        await this.coordinator.applyIntentOutcome(outcome);
      }
      await this.waitForAdmissionRegistrations();
      this.resolveAdmissionWaiter(intent.intentId, outcome);
      return this.drainLoop();
    } catch (error) {
      if (isAuthorizationError(error)) {
        await this.waitForAdmissionRegistrations();
        this.rejectAdmissionWaiter(intent.intentId, error);
        await this.authorizationRevoked();
        return;
      }
      if (isPermanentIntentRejection(error)) {
        const outcome: IntentOutcome = {
          intentId: intent.intentId,
          status: error.status === 403 ? "denied" : "failed",
          reason: error.message,
        };
        await this.coordinator.applyIntentOutcome(outcome);
        await this.waitForAdmissionRegistrations();
        this.resolveAdmissionWaiter(intent.intentId, outcome);
        return this.drainLoop();
      }
      await this.coordinator
        .markIntentTransportFailed(intent.intentId, errorMessage(error))
        .catch(() => undefined);
      await this.waitForAdmissionRegistrations();
      const queuedReason =
        "saved locally; retrying when the gateway is reachable";
      this.resolveAdmissionWaiter(intent.intentId, {
        intentId: intent.intentId,
        status: "queued",
        reason: queuedReason,
      });
      // The outbox keeps its order, so nothing behind the failed head is
      // claimed until the retry: settle those writers on their durable
      // admission instead of leaving them awaiting forever (#880).
      this.resolveAdmissionWaitersAsQueued(queuedReason);
      this.scheduleRetry();
    }
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
          `Shape ${requested} is not available to app ${appId}${resolvedPurpose ? ` for purpose ${resolvedPurpose}` : ""}`
        );
      }
      return requested;
    }
    if (candidates.length !== 1) {
      const purposeLabel = resolvedPurpose
        ? ` at purpose ${resolvedPurpose}`
        : "";
      throw new ReplicaProtocolError(
        candidates.length === 0
          ? `No offline shape for ${appId}/${entity}${purposeLabel}`
          : `Multiple offline shapes match ${appId}/${entity}${purposeLabel}; shapeId is required`
      );
    }
    return candidates[0]!.shapeId;
  }

  private scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushIntents();
    }, this.#retryDelayMs);
  }

  private scheduleBootstrapRetry(): void {
    if (this.#bootstrapRetryTimer || this.#closed || !this.#isOnline()) return;
    const delay = Math.min(
      this.#retryDelayMs * 2 ** Math.min(this.#bootstrapRetryAttempt, 4),
      30_000
    );
    this.#bootstrapRetryAttempt += 1;
    this.#bootstrapRetryTimer = setTimeout(() => {
      this.#bootstrapRetryTimer = undefined;
      void this.bootstrapWhenReachable();
    }, delay);
  }

  private resolveAdmissionWaiter(
    intentId: string,
    result: ShellReplicaWriteResult
  ): void {
    const waiters = this.#admissionWaiters.get(intentId);
    if (!waiters) return;
    this.#admissionWaiters.delete(intentId);
    for (const waiter of waiters) waiter.resolve(structuredClone(result));
  }

  private rejectAdmissionWaiter(intentId: string, error: unknown): void {
    const waiters = this.#admissionWaiters.get(intentId);
    if (!waiters) return;
    this.#admissionWaiters.delete(intentId);
    for (const waiter of waiters) waiter.reject(error);
  }

  private rejectAdmissionWaiters(error: unknown): void {
    for (const intentId of this.#admissionWaiters.keys()) {
      this.rejectAdmissionWaiter(intentId, error);
    }
  }

  private resolveAdmissionWaitersAsQueued(reason: string): void {
    for (const intentId of this.#admissionWaiters.keys()) {
      this.resolveAdmissionWaiter(intentId, {
        intentId,
        status: "queued",
        reason,
      });
    }
  }

  private beginAdmissionRegistration(): void {
    if (this.#admissionRegistrations === 0) {
      this.#admissionRegistrationBarrier = new Promise((resolve) => {
        this.#releaseAdmissionRegistrationBarrier = resolve;
      });
    }
    this.#admissionRegistrations += 1;
  }

  private finishAdmissionRegistration(): void {
    this.#admissionRegistrations -= 1;
    if (this.#admissionRegistrations !== 0) return;
    const release = this.#releaseAdmissionRegistrationBarrier;
    this.#releaseAdmissionRegistrationBarrier = undefined;
    this.#admissionRegistrationBarrier = undefined;
    release?.();
  }

  private async waitForAdmissionRegistrations(): Promise<void> {
    if (!this.#admissionRegistrationBarrier) return;
    await this.#admissionRegistrationBarrier;
    return this.waitForAdmissionRegistrations();
  }

  private async authorizationRevoked(): Promise<void> {
    this.#onAuthorizationRevoked?.(this);
    purgeBrowserReplicaCaches();
    await purgeSessionTerminal(this);
  }

  private readonly onOnline = (): void => {
    if (this.#bootstrapRetryTimer) clearTimeout(this.#bootstrapRetryTimer);
    this.#bootstrapRetryTimer = undefined;
    this.#bootstrapRetryAttempt = 0;
    if (!this.#hasCursor) void this.bootstrapWhenReachable();
    void this.flushIntents();
  };

  private detach(): void {
    this.#eventTarget.removeEventListener("online", this.onOnline);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#bootstrapRetryTimer) clearTimeout(this.#bootstrapRetryTimer);
    this.#bootstrapRetryTimer = undefined;
    this.#drainRequested = false;
  }

  private assertOpen(): void {
    if (this.#closed)
      throw new ReplicaProtocolError("Replica session is closed");
  }
}

export async function openReplicaShellSession(
  gatewayAuth: GatewayAuth,
  options: OpenReplicaShellSessionOptions = {}
): Promise<ReplicaShellSession> {
  if (!gatewayAuth.vaultId)
    throw new ReplicaProtocolError("An addressed vault is required");
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const rememberRequested = gatewayAuth.rememberDevice === true;
  const remember = rememberRequested
    ? await prepareRememberedReplicaIdentity(identity, {
        ...(options.indexedDbFactory
          ? { indexedDbFactory: options.indexedDbFactory }
          : {}),
        ...(options.inventory ? { inventory: options.inventory } : {}),
      })
    : false;
  if (!rememberRequested) {
    await purgeRememberedReplicaIdentities(
      (item) => sameIdentity(item, identity),
      {
        ...(options.indexedDbFactory
          ? { indexedDbFactory: options.indexedDbFactory }
          : {}),
        ...(options.inventory ? { inventory: options.inventory } : {}),
        purgeSelector: { kind: "identity", ...identity },
      }
    );
  }
  let session: ReplicaShellSession | undefined = undefined;
  let pendingBootstrap = false;
  let persistedShapeIds: readonly string[] = [];
  const fetcher = options.fetcher ?? fetchReplicaForScope(gatewayAuth);
  const { replica, status } = await createReplicaCoordinator(
    identity,
    remember,
    {
      ...(options.workerFactory
        ? { workerFactory: options.workerFactory }
        : {}),
      ...(options.intentStore ? { intentStore: options.intentStore } : {}),
      ...(options.indexedDbFactory
        ? { indexedDbFactory: options.indexedDbFactory }
        : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      // Name THIS session's scope (#599) — ambient overloads bind to the focused vault.
      changeFeed: {
        subscribe: (listener) => subscribeVaultChanges(listener, gatewayAuth),
        setShapeIds: async (shapeIds: readonly string[]) => {
          persistedShapeIds = [...shapeIds];
          await setVaultChangeShapeIds(persistedShapeIds, gatewayAuth);
        },
        resume: (cursor: ReplicaCursor) =>
          resumeVaultChanges(cursor, gatewayAuth),
      },
      pullChanges: async (cursor, signal) => {
        try {
          return await fetchReplicaChanges(
            gatewayAuth,
            cursor,
            signal,
            persistedShapeIds,
            fetcher
          );
        } catch (error) {
          if (isAuthorizationError(error) && session) revokeAndPurge(session);
          throw error;
        }
      },
      onCursorAdvanced: (cursor, schemaEpoch) => {
        void postReplicaCheckpoint(
          gatewayAuth,
          cursor,
          schemaEpoch,
          fetcher
        ).catch((error) => {
          if (isAuthorizationError(error) && session) revokeAndPurge(session);
        });
      },
      onRebootstrapRequired: () => {
        if (session) session.requireBootstrap();
        else pendingBootstrap = true;
      },
    }
  );
  const rememberStorage =
    remember &&
    status.mode === "opfs-sahpool" &&
    status.intentDurability !== "memory";
  if (remember && !rememberStorage) {
    try {
      await unregisterRememberedReplicaIdentity(identity, {
        ...(options.indexedDbFactory
          ? { indexedDbFactory: options.indexedDbFactory }
          : {}),
        ...(options.inventory ? { inventory: options.inventory } : {}),
      });
    } catch (error) {
      await replica.close().catch(() => undefined);
      throw error;
    }
  }
  session = new ReplicaShellSession(gatewayAuth, replica, {
    ...options,
    fetcher,
    rememberStorage,
    onAuthorizationRevoked: options.onAuthorizationRevoked ?? forgetSession,
  });
  try {
    await session.start(status);
  } catch (error) {
    // NEVER LEAVE THE HANDLES BEHIND (#922 E3). `start` awaits the first
    // bootstrap, so a bootstrap that fails rejects this open — and the scope
    // registry drops the entry, so the next lease opens a SECOND worker on the
    // same OPFS pool. The first worker still holds its access handles, the
    // second cannot create them, and every later open fights the same files.
    // Closing here hands them back before the failure is re-raised.
    await session.close().catch(() => undefined);
    throw error;
  }
  if (pendingBootstrap) session.requireBootstrap();
  return session;
}

/** One mounted scope. Last-holder release stays warm while the page is
 *  visible; `replicaScopeDisposition` decides (#599, #922 C6). */
interface SessionEntry {
  key: string;
  identity: ReplicaIdentity;
  promise: Promise<ReplicaShellSession>;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Release twice is a no-op. */
export interface ReplicaScopeLease {
  readonly session: ReplicaShellSession;
  release: () => void;
}

const sessions = new Map<string, SessionEntry>();
const SESSION_IDLE_GRACE_MS = 30_000;

/** The page as the scope registry sees it (#922 C6). */
export type ReplicaPageState = "visible" | "hidden" | "frozen";
let pageState: ReplicaPageState = "visible";
export function replicaPageState(): ReplicaPageState {
  return pageState;
}

/**
 * WHAT A SCOPE NOBODY IS READING DOES NEXT (#922 C6).
 *
 * `warm` is the 30-second grace (#599): leaving an app and coming back must not
 * pay a second open, so a released scope keeps its SQLite handles that long.
 * The grace is a bet that the owner is still here, and a hidden or frozen page
 * has lost that bet — the browser freezes hidden pages precisely when it wants
 * their memory back, and a replica holding OPFS access handles it is not
 * reading is the first thing that should give them up.
 *
 * A scope a screen still holds is never closed under it: the lease hands the
 * session object straight to the mounted app, so closing it would fail the
 * app's next read rather than reopen. Those close when their last holder
 * releases, which under `hidden`/`frozen` is at once rather than in 30 s.
 */
export function replicaScopeDisposition(
  page: ReplicaPageState,
  refs: number
): "hold" | "warm" | "close" {
  if (refs > 0) return "hold";
  return page === "visible" ? "warm" : "close";
}
let addressedFallback:
  | { key: string; promise: Promise<string | undefined> }
  | undefined;
let lifecycleInstalled = false;
let lifecyclePurge = Promise.resolve();
const terminalPurgeRetryLoop = new TerminalReplicaPurgeRetryLoop();

function entryFor(gatewayAuth: GatewayAuth): SessionEntry {
  installReplicaStorageLifecycle();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const key = identityKey(identity);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return existing;
  }
  const promise = openReplicaShellSession(gatewayAuth);
  const entry: SessionEntry = { key, identity, promise, refs: 0 };
  sessions.set(key, entry);
  promise.catch(() => {
    if (sessions.get(key) === entry) sessions.delete(key);
  });
  return entry;
}

/** Refuse a scope from another gateway rather than opening against the wrong host. */
async function gatewayAuthForIdentity(
  identity: ReplicaIdentity
): Promise<GatewayAuth> {
  const base = await auth();
  const gatewayId =
    base.gatewayId?.trim() || normalizedGatewayUrl(base.baseUrl);
  if (gatewayId !== identity.gatewayId) {
    throw new ReplicaProtocolError(
      `Scope ${identity.vaultId} belongs to a different gateway`
    );
  }
  return { ...base, vaultId: identity.vaultId };
}

function scheduleIdleClose(entry: SessionEntry): void {
  if (entry.idleTimer) return;
  const timer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (entry.refs > 0 || sessions.get(entry.key) !== entry) return;
    void dropEntry(entry, "close");
  }, SESSION_IDLE_GRACE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  entry.idleTimer = timer;
}

function reclaimScope(entry: SessionEntry): void {
  const disposition = replicaScopeDisposition(pageState, entry.refs);
  if (disposition === "hold") return;
  if (disposition === "warm") {
    scheduleIdleClose(entry);
    return;
  }
  void dropEntry(entry, "close");
}

/**
 * The page-lifecycle signals the scope registry acts on (#922 C6). `freeze` is
 * this platform's memory-pressure event: the browser fires it on a hidden page
 * whose memory it is reclaiming, and a page that is discarded after it never
 * runs again — so the handles have to go back before it returns.
 */
function installPageLifecycle(): void {
  if (typeof document === "undefined") return;
  const enter = (next: ReplicaPageState): void => {
    pageState = next;
    if (next === "visible") return;
    // Snapshot: reclaiming a scope deletes it from the map being walked.
    const open = [...sessions.values()];
    for (const entry of open) reclaimScope(entry);
  };
  document.addEventListener("visibilitychange", () => {
    enter(document.visibilityState === "hidden" ? "hidden" : "visible");
  });
  document.addEventListener("freeze", () => enter("frozen"));
  document.addEventListener("resume", () => enter("visible"));
}

async function dropEntry(
  entry: SessionEntry,
  mode: "purge" | "close"
): Promise<void> {
  if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  await entry.promise
    .then((session) => (mode === "purge" ? session.purge() : session.close()))
    .catch(() => undefined)
    .finally(() => {
      if (mode === "purge") terminalPurgeRetryLoop.wake();
    });
}

export async function getReplicaShellSessionFor(
  identity: ReplicaIdentity
): Promise<ReplicaShellSession> {
  return entryFor(await gatewayAuthForIdentity(identity)).promise;
}

export async function acquireReplicaShellSession(
  identity: ReplicaIdentity
): Promise<ReplicaScopeLease> {
  const entry = entryFor(await gatewayAuthForIdentity(identity));
  entry.refs += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    reclaimScope(entry);
  };
  try {
    return { session: await entry.promise, release };
  } catch (error) {
    release();
    throw error;
  }
}

export async function getReplicaShellSession(): Promise<ReplicaShellSession> {
  return entryFor(await addressedGatewayAuth()).promise;
}

export async function purgeReplicaShellSession(): Promise<void> {
  await applyScopeTeardownsInOrder([...sessions.values()], (entry) =>
    dropEntry(entry, "purge")
  );
}

export async function purgeCurrentReplicaDevice(): Promise<void> {
  purgeBrowserReplicaCaches();
  forgetAllAddressedVaults();
  addressedFallback = undefined;
  // Fan across every mounted identity, not just the focused one (#599).
  const identities = new Map<string, ReplicaIdentity>(
    [...sessions.values()].map((entry) => [entry.key, entry.identity])
  );
  try {
    const gatewayAuth = await auth();
    if (gatewayAuth.vaultId) {
      const identity = replicaIdentityForGatewayAuth(gatewayAuth);
      identities.set(identityKey(identity), identity);
    }
  } catch {
    // Open sessions still carry identities and purge below.
  }
  await purgeReplicaShellSession();
  try {
    await applyScopeTeardownsInOrder(identities.values(), (identity) =>
      purgeRememberedReplicaIdentities((item) => sameIdentity(item, identity), {
        purgeSelector: { kind: "identity", ...identity },
      })
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Could not durably schedule remembered replica discovery"
    ) {
      throw error;
    }
    // Selector was written before deletion; a missing inventory is retried.
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

export async function closeReplicaShellSession(): Promise<void> {
  await applyScopeTeardownsInOrder([...sessions.values()], (entry) =>
    dropEntry(entry, "close")
  );
}

/**
 * Terminal events plus the page's own lifecycle (#599, #922 C6). Do not re-wire
 * `onVaultChanged` to purge — focus change must close warm, not wipe the scope
 * just left; hiding and freezing close warm too, they only skip the grace.
 */
export function installReplicaStorageLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  installPageLifecycle();
  terminalPurgeRetryLoop.start();
  window.CentraidApi.onGatewayChanged?.((detail) => {
    queueLifecyclePurge(() => handleGatewayChanged(detail));
  });
}

interface GatewayChangedDetail {
  activeGatewayId: string;
  gatewayId?: string;
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
}

async function handleGatewayChanged(
  detail: GatewayChangedDetail
): Promise<void> {
  const activeGatewayId = detail.gatewayId ?? detail.activeGatewayId;
  const purgeGatewayIds = new Set<string>();
  if (detail.removedGatewayId) purgeGatewayIds.add(detail.removedGatewayId);
  if (detail.purgeReplicaGatewayId)
    purgeGatewayIds.add(detail.purgeReplicaGatewayId);
  for (const gatewayId of purgeGatewayIds) forgetAddressedVault(gatewayId);
  if (addressedFallback && purgeGatewayIds.has(addressedFallback.key))
    addressedFallback = undefined;
  // Removed gateway is terminal; lost-focus scopes close warm and keep storage.
  await applyScopeTeardownsInOrder([...sessions.values()], async (entry) => {
    if (purgeGatewayIds.has(entry.identity.gatewayId))
      await dropEntry(entry, "purge");
    else if (entry.identity.gatewayId !== activeGatewayId)
      await dropEntry(entry, "close");
  });
  await applyScopeTeardownsInOrder(purgeGatewayIds, (gatewayId) =>
    purgeRememberedReplicaIdentities(
      (identity) => identity.gatewayId === gatewayId,
      {
        purgeSelector: { kind: "gateway", gatewayId },
      }
    )
  );
}

function queueLifecyclePurge(task: () => Promise<void>): void {
  lifecyclePurge = lifecyclePurge
    .then(task, task)
    .catch(() => undefined)
    .finally(() => terminalPurgeRetryLoop.wake());
}

function forgetSession(session: ReplicaShellSession): void {
  for (const entry of sessions.values()) {
    void entry.promise.then((active) => {
      if (active === session && sessions.get(entry.key) === entry)
        sessions.delete(entry.key);
    });
  }
}

function revokeAndPurge(session: ReplicaShellSession): void {
  forgetSession(session);
  purgeBrowserReplicaCaches();
  void purgeSessionTerminal(session);
}

async function purgeSessionTerminal(
  session: ReplicaShellSession
): Promise<void> {
  try {
    await session.purge();
  } catch {
    await purgeReplicaIdentityStorage(
      replicaIdentityForGatewayAuth(session.gatewayAuth)
    ).catch(() => undefined);
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

function purgeBrowserReplicaCaches(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "centraid:purge-tunnel-cache",
    });
  } catch {
    /* Desktop and hardened browsers have no service-worker cache lane. */
  }
  try {
    if (typeof caches !== "undefined") {
      void caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter(
                (name) =>
                  name.startsWith("centraid-tunnel-assets-") ||
                  name.startsWith("centraid-tunnel-blobs-")
              )
              .map((name) => caches.delete(name))
          )
        )
        .catch(() => undefined);
    }
  } catch {
    /* Cache Storage may be denied even when the global is present. */
  }
}

/**
 * Replica store is keyed by `(gatewayId, vaultId)` — do not guess
 * `listVaults()[0]`; device-token addresses the oldest enrollment (#289).
 */
export async function addressedGatewayAuth(): Promise<GatewayAuth> {
  const gatewayAuth = await auth();
  const key =
    gatewayAuth.gatewayId?.trim() || normalizedGatewayUrl(gatewayAuth.baseUrl);
  if (gatewayAuth.vaultId) {
    rememberAddressedVault(key, gatewayAuth.vaultId);
    return gatewayAuth;
  }
  let pending = addressedFallback?.key === key ? addressedFallback : undefined;
  if (!pending) {
    const promise = vaultStatus()
      .then((status) => status?.vaultId)
      .catch(() => undefined);
    pending = { key, promise };
    addressedFallback = pending;
    void promise.then((vaultId) => {
      // No vault plane — do not pin "unknown"; let the next call re-ask.
      if (vaultId === undefined && addressedFallback?.promise === promise) {
        addressedFallback = undefined;
      } else if (vaultId) rememberAddressedVault(key, vaultId);
    });
  }
  // Last-known id for this gateway, without waiting on `_vault/status` (Iroh
  // dial). Not `listVaults()[0]` — the gateway's own previous answer.
  const remembered = rememberedAddressedVault(key);
  if (remembered) return { ...gatewayAuth, vaultId: remembered };
  const vaultId = await pending.promise;
  return vaultId ? { ...gatewayAuth, vaultId } : gatewayAuth;
}

const ADDRESSED_VAULT_KEY = "centraid.v1.replica.addressedVault";

function addressedVaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readAddressedVaults(): Record<string, string> {
  try {
    const raw = addressedVaultStorage()?.getItem(ADDRESSED_VAULT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeAddressedVaults(map: Record<string, string>): void {
  try {
    const storage = addressedVaultStorage();
    if (!storage) return;
    if (Object.keys(map).length === 0) storage.removeItem(ADDRESSED_VAULT_KEY);
    else storage.setItem(ADDRESSED_VAULT_KEY, JSON.stringify(map));
  } catch {
    /* A storage denial only costs the fast path — the network ask still runs. */
  }
}

function rememberedAddressedVault(gatewayKey: string): string | undefined {
  const value = readAddressedVaults()[gatewayKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rememberAddressedVault(gatewayKey: string, vaultId: string): void {
  const map = readAddressedVaults();
  if (map[gatewayKey] === vaultId) return;
  map[gatewayKey] = vaultId;
  writeAddressedVaults(map);
}

function forgetAddressedVault(gatewayKey: string): void {
  const map = readAddressedVaults();
  if (!(gatewayKey in map)) return;
  delete map[gatewayKey];
  writeAddressedVaults(map);
}

function forgetAllAddressedVaults(): void {
  writeAddressedVaults({});
}

export function replicaIdentityForGatewayAuth(
  gatewayAuth: GatewayAuth
): ReplicaIdentity {
  if (!gatewayAuth.vaultId)
    throw new ReplicaProtocolError("An addressed vault is required");
  return {
    gatewayId:
      gatewayAuth.gatewayId?.trim() ||
      normalizedGatewayUrl(gatewayAuth.baseUrl),
    vaultId: gatewayAuth.vaultId,
  };
}

function normalizedGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `url:${url.toString()}`;
  } catch {
    return `url:${value.replace(/\/+$/u, "")}`;
  }
}

function sameIdentity(left: ReplicaIdentity, right: ReplicaIdentity): boolean {
  return left.gatewayId === right.gatewayId && left.vaultId === right.vaultId;
}

function identityKey(identity: ReplicaIdentity): string {
  return `${identity.gatewayId}\u0000${identity.vaultId}`;
}

function shapeId(shape: ReplicaShape): string {
  return shape.shapeId;
}

/**
 * Stamp this session's vault. Ambient `withVaultHeader` would write focused
 * vault rows into another scope's OPFS store (#599).
 */
export function fetchReplicaForScope(gatewayAuth: GatewayAuth): ReplicaFetcher {
  return (baseUrl, pathname, init) => {
    if (!gatewayAuth.vaultId) return doFetch(baseUrl, pathname, init);
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set(VAULT_HEADER, gatewayAuth.vaultId);
    return doFetch(baseUrl, pathname, { ...init, headers });
  };
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === "auth_required";
}

function isTransientGatewayError(error: unknown): boolean {
  return (
    error instanceof GatewayClientError &&
    (error.code === "gateway_unreachable" || error.code === "gateway_error")
  );
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

function mergeIntentOutcomes(
  baseline: readonly IntentOutcome[],
  exact: readonly IntentOutcome[]
): IntentOutcome[] {
  const byId = new Map(baseline.map((outcome) => [outcome.intentId, outcome]));
  for (const outcome of exact) byId.set(outcome.intentId, outcome);
  return [...byId.values()];
}

function admissionResult(
  intent: ReplicaIntent
): ShellReplicaWriteResult | undefined {
  if (intent.state === "awaiting-change") {
    return { intentId: intent.intentId, status: "in-flight" };
  }
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

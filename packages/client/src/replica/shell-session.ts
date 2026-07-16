// governance: allow-repo-hygiene file-size-limit (#406) shell session keeps replica ownership, lifecycle teardown, and intent drain in one auditable boundary
import { auth, doFetch, GatewayClientError, type GatewayAuth } from '../gateway-client-core.js';
import {
  resumeVaultChanges,
  setVaultChangeShapeIds,
  subscribeVaultChanges,
  clearVaultChangeCursor,
} from '../vault-change-feed.js';
import { createReplicaCoordinator, type ReplicaWebCoordinatorOptions } from './coordinator-web.js';
import { ReplicaProtocolError } from './errors.js';
import { validateOptimisticMutation } from './query.js';
import {
  fetchReplicaBootstrap,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
  postReplicaCheckpoint,
  postReplicaIntent,
  type ReplicaFetcher,
  ReplicaTransportError,
} from './shell-transport.js';
import {
  deferTerminalReplicaPurge,
  markReplicaIdentityTerminal,
  prepareRememberedReplicaIdentity,
  purgeReplicaIdentityStorage,
  purgeRememberedReplicaIdentities,
  unregisterRememberedReplicaIdentity,
  type ReplicaIdentityInventory,
} from './storage-manifest.js';
import { TerminalReplicaPurgeRetryLoop } from './terminal-purge-retry.js';
import {
  DEFAULT_REPLICA_PURPOSE,
  type EnqueueIntentInput,
  type IntentOutcome,
  type OptimisticMutation,
  type ReplicaCursor,
  type ReplicaDependency,
  type ReplicaIdentity,
  type ReplicaIntent,
  type ReplicaInvalidation,
  type ReplicaReadRequest,
  type ReplicaReadWireResult,
  type ReplicaSearchRequest,
  type ReplicaSearchWireResult,
  type ReplicaShape,
  type ReplicaStatus,
  type ReplicaValue,
} from './types.js';

export type ShellReplicaReadRequest = Omit<ReplicaReadRequest, 'shapeId'> & {
  shapeId?: string;
};

export type ShellReplicaSearchRequest = Omit<ReplicaSearchRequest, 'shapeId'> & {
  shapeId?: string;
};

export type ShellOptimisticMutation =
  | (Omit<Extract<OptimisticMutation, { op: 'upsert' }>, 'shapeId'> & {
      shapeId?: string;
      purpose?: string;
    })
  | (Omit<Extract<OptimisticMutation, { op: 'delete' }>, 'shapeId'> & {
      shapeId?: string;
      purpose?: string;
    });

export interface ShellReplicaWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: ShellOptimisticMutation[];
  intentId?: string;
}

export type ShellReplicaWriteResult =
  | IntentOutcome
  | { intentId: string; status: 'queued' | 'in-flight'; reason?: string };

export interface ShellReplicaCoordinator {
  bootstrap(snapshot: Awaited<ReturnType<typeof fetchReplicaBootstrap>>): Promise<ReplicaCursor>;
  status(): Promise<ReplicaStatus>;
  catalog(): Promise<ReplicaShape[]>;
  readWire(request: ReplicaReadRequest): Promise<ReplicaReadWireResult>;
  searchWire(request: ReplicaSearchRequest): Promise<ReplicaSearchWireResult>;
  enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent>;
  claimNextIntent(): Promise<ReplicaIntent | undefined>;
  markIntentTransportFailed(intentId: string, reason?: string): Promise<ReplicaIntent>;
  markIntentAwaitingChange(intentId: string): Promise<ReplicaIntent>;
  applyIntentOutcome(outcome: IntentOutcome): Promise<ReplicaIntent | undefined>;
  recoverSending(): Promise<ReplicaIntent[]>;
  pendingIntents(): Promise<ReplicaIntent[]>;
  subscribeInvalidations(
    listener: (invalidations: readonly ReplicaInvalidation[]) => void,
  ): () => void;
  close(): Promise<void>;
  purge(): Promise<void>;
}

export interface ReplicaShellSessionOptions {
  fetcher?: ReplicaFetcher;
  eventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  isOnline?: () => boolean;
  retryDelayMs?: number;
  indexedDbFactory?: IDBFactory;
  /** True only when the coordinator actually opened durable storage. */
  rememberStorage?: boolean;
  /** Test seam for the authoritative global durable-scope inventory. */
  inventory?: ReplicaIdentityInventory;
  onAuthorizationRevoked?: (session: ReplicaShellSession) => void;
}

export interface OpenReplicaShellSessionOptions extends ReplicaShellSessionOptions {
  workerFactory?: ReplicaWebCoordinatorOptions['workerFactory'];
  intentStore?: ReplicaWebCoordinatorOptions['intentStore'];
  idFactory?: () => string;
}

/** One shell-owned replica + durable intent shipper for an authenticated scope. */
export class ReplicaShellSession {
  readonly #fetcher: ReplicaFetcher;
  readonly #eventTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly #isOnline: () => boolean;
  readonly #retryDelayMs: number;
  readonly #indexedDbFactory: IDBFactory | undefined;
  readonly #rememberStorage: boolean;
  readonly #inventory: ReplicaIdentityInventory | undefined;
  readonly #onAuthorizationRevoked: ((session: ReplicaShellSession) => void) | undefined;
  #catalog: ReplicaShape[] = [];
  #bootstrapPromise: Promise<void> | undefined;
  #bootstrapRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #bootstrapRetryAttempt = 0;
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
    options: ReplicaShellSessionOptions = {},
  ) {
    this.#fetcher = options.fetcher ?? fetchReplicaDefault;
    this.#eventTarget = options.eventTarget ?? window;
    this.#isOnline = options.isOnline ?? (() => navigator.onLine !== false);
    this.#retryDelayMs = options.retryDelayMs ?? 2_000;
    this.#indexedDbFactory = options.indexedDbFactory;
    this.#rememberStorage = options.rememberStorage === true;
    this.#inventory = options.inventory;
    this.#onAuthorizationRevoked = options.onAuthorizationRevoked;
  }

  async start(status: ReplicaStatus): Promise<this> {
    this.#eventTarget.addEventListener('online', this.onOnline);
    await this.coordinator.recoverSending();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) this.#catalog = await this.coordinator.catalog();
    else await this.bootstrapWhenReachable();
    void this.flushIntents();
    return this;
  }

  async read(appId: string, request: ShellReplicaReadRequest): Promise<ReplicaReadWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId, request.purpose);
    return this.coordinator.readWire({ ...request, shapeId });
  }

  async search(
    appId: string,
    request: ShellReplicaSearchRequest,
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId, request.purpose);
    return this.coordinator.searchWire({ ...request, shapeId });
  }

  async write(appId: string, input: ShellReplicaWriteInput): Promise<ShellReplicaWriteResult> {
    this.assertOpen();
    if (!input.action) throw new ReplicaProtocolError('Replica action is required');
    const optimistic = (input.optimistic ?? []).map((mutation) => {
      const { purpose, shapeId, ...core } = mutation;
      return {
        ...core,
        shapeId: this.resolveShapeId(appId, mutation.entity, shapeId, purpose),
      };
    }) as OptimisticMutation[];
    for (const mutation of optimistic) {
      const shape = this.#catalog.find((candidate) => candidate.shapeId === mutation.shapeId);
      const schema = shape?.entities.find((candidate) => candidate.entity === mutation.entity);
      if (!schema) {
        throw new ReplicaProtocolError(
          `Optimistic mutation targets unavailable shape ${mutation.shapeId}/${mutation.entity}`,
        );
      }
      validateOptimisticMutation(mutation, schema);
    }
    const dependencies = this.#catalog
      .filter((shape) => shape.appId === appId)
      .flatMap((shape) =>
        shape.entities.map((entity) => ({ shapeId: shape.shapeId, entity: entity.entity })),
      );
    this.beginAdmissionRegistration();
    try {
      const intent = await this.coordinator.enqueue({
        ...(input.intentId ? { intentId: input.intentId } : {}),
        appId,
        action: input.action,
        input: input.input,
        optimistic,
        dependencies,
      });
      this.assertOpen();
      const existingAdmission = admissionResult(intent);
      if (existingAdmission) return existingAdmission;
      if (!this.#isOnline()) {
        return { intentId: intent.intentId, status: 'queued', reason: 'waiting for a connection' };
      }
      const admitted = new Promise<ShellReplicaWriteResult>((resolve, reject) => {
        const waiters = this.#admissionWaiters.get(intent.intentId) ?? new Set();
        waiters.add({ resolve, reject });
        this.#admissionWaiters.set(intent.intentId, waiters);
      });
      void this.flushIntents();
      return admitted;
    } finally {
      this.finishAdmissionRegistration();
    }
  }

  subscribe(
    appId: string,
    dependencies: ShellReplicaReadRequest[] | ReplicaDependency[] | undefined,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void,
  ): () => void {
    this.assertOpen();
    const requested = dependencies ?? [];
    const explicitShapes = new Set(
      requested.flatMap((dependency) =>
        dependency.shapeId ? [`${dependency.shapeId}\u0000${dependency.entity}`] : [],
      ),
    );
    const wildcardEntities = new Set(
      requested.flatMap((dependency) => (dependency.shapeId ? [] : [dependency.entity])),
    );
    return this.coordinator.subscribeInvalidations((invalidations) => {
      const appShapes = new Set(
        this.#catalog.filter((shape) => shape.appId === appId).map(shapeId),
      );
      const relevant = invalidations.filter(
        (invalidation) =>
          invalidation.source === 'purge' ||
          (appShapes.has(invalidation.shapeId) &&
            (requested.length === 0 ||
              wildcardEntities.has(invalidation.entity) ||
              explicitShapes.has(`${invalidation.shapeId}\u0000${invalidation.entity}`))),
      );
      if (relevant.length > 0) listener(structuredClone(relevant));
    });
  }

  async flushIntents(): Promise<void> {
    if (this.#closed) return;
    if (!this.#isOnline()) {
      this.resolveAdmissionWaitersAsQueued('saved locally; waiting for a connection');
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
    this.rejectAdmissionWaiters(new ReplicaProtocolError('Replica session closed'));
    this.detach();
    await this.coordinator.close();
  }

  async purge(): Promise<void> {
    clearVaultChangeCursor(this.gatewayAuth);
    const identity = replicaIdentityForGatewayAuth(this.gatewayAuth);
    const inventoryOptions = {
      ...(this.#indexedDbFactory ? { indexedDbFactory: this.#indexedDbFactory } : {}),
      ...(this.#inventory ? { inventory: this.#inventory } : {}),
    };
    if (this.#closed) {
      if (this.#rememberStorage) await purgeReplicaIdentityStorage(identity, inventoryOptions);
      return;
    }
    this.#closed = true;
    this.rejectAdmissionWaiters(new ReplicaProtocolError('Replica session purged'));
    this.detach();
    let terminalTracked = false;
    if (this.#rememberStorage) {
      terminalTracked = await markReplicaIdentityTerminal(identity, inventoryOptions);
      if (!terminalTracked) {
        throw new ReplicaProtocolError('Could not durably schedule remembered replica purge');
      }
    }
    try {
      await this.coordinator.purge();
      if (this.#rememberStorage) {
        await unregisterRememberedReplicaIdentity(identity, inventoryOptions);
      }
    } catch (error) {
      if (terminalTracked) {
        await deferTerminalReplicaPurge(identity, inventoryOptions).catch(() => undefined);
      }
      terminalPurgeRetryLoop.wake();
      throw error;
    }
  }

  requireBootstrap(): void {
    this.#hasCursor = false;
    if (!this.#closed) void this.bootstrapWhenReachable();
  }

  private async bootstrapWhenReachable(): Promise<void> {
    if (this.#bootstrapPromise || this.#closed || !this.#isOnline()) return this.#bootstrapPromise;
    this.#bootstrapPromise = this.bootstrap().finally(() => {
      this.#bootstrapPromise = undefined;
    });
    return this.#bootstrapPromise;
  }

  private async bootstrap(): Promise<void> {
    try {
      const snapshot = await fetchReplicaBootstrap(this.gatewayAuth, this.#fetcher);
      const pending = await this.coordinator.pendingIntents();
      const exactOutcomes = await fetchReplicaIntentOutcomes(
        this.gatewayAuth,
        pending.map((intent) => intent.intentId),
        snapshot.cursor,
        this.#fetcher,
      );
      snapshot.outcomes = mergeIntentOutcomes(snapshot.outcomes ?? [], exactOutcomes);
      await this.coordinator.bootstrap(snapshot);
      this.#hasCursor = true;
      this.#catalog = await this.coordinator.catalog();
      for (const outcome of snapshot.outcomes ?? []) {
        this.resolveAdmissionWaiter(outcome.intentId, outcome);
      }
      this.#bootstrapRetryAttempt = 0;
    } catch (error) {
      if (isAuthorizationError(error)) await this.authorizationRevoked();
      else if (isTransientGatewayError(error)) this.scheduleBootstrapRetry();
      else throw error;
    }
  }

  private async drainLoop(): Promise<void> {
    while (!this.#closed && this.#isOnline()) {
      await this.waitForAdmissionRegistrations();
      if (this.#closed) return;
      if (!this.#isOnline()) {
        this.resolveAdmissionWaitersAsQueued('saved locally; waiting for a connection');
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
        const { outcome } = await postReplicaIntent(this.gatewayAuth, intent, this.#fetcher);
        if (outcome.status === 'executed' || outcome.status === 'in-flight') {
          await this.coordinator.markIntentAwaitingChange(intent.intentId);
        } else {
          await this.coordinator.applyIntentOutcome(outcome);
        }
        await this.waitForAdmissionRegistrations();
        this.resolveAdmissionWaiter(intent.intentId, outcome);
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
            status: error.status === 403 ? 'denied' : 'failed',
            reason: error.message,
          };
          await this.coordinator.applyIntentOutcome(outcome);
          await this.waitForAdmissionRegistrations();
          this.resolveAdmissionWaiter(intent.intentId, outcome);
          continue;
        }
        await this.coordinator
          .markIntentTransportFailed(intent.intentId, errorMessage(error))
          .catch(() => undefined);
        await this.waitForAdmissionRegistrations();
        this.resolveAdmissionWaiter(intent.intentId, {
          intentId: intent.intentId,
          status: 'queued',
          reason: 'saved locally; retrying when the gateway is reachable',
        });
        this.scheduleRetry();
        return;
      }
    }
  }

  private resolveShapeId(
    appId: string,
    entity: string,
    requested?: string,
    purpose?: string,
  ): string {
    const resolvedPurpose = purpose ?? (requested ? undefined : DEFAULT_REPLICA_PURPOSE);
    const candidates = this.#catalog.filter(
      (shape) =>
        shape.appId === appId &&
        (resolvedPurpose === undefined || shape.purpose === resolvedPurpose) &&
        shape.entities.some((item) => item.entity === entity),
    );
    if (requested) {
      if (!candidates.some((shape) => shape.shapeId === requested)) {
        throw new ReplicaProtocolError(
          `Shape ${requested} is not available to app ${appId}${resolvedPurpose ? ` for purpose ${resolvedPurpose}` : ''}`,
        );
      }
      return requested;
    }
    if (candidates.length !== 1) {
      const purposeLabel = resolvedPurpose ? ` at purpose ${resolvedPurpose}` : '';
      throw new ReplicaProtocolError(
        candidates.length === 0
          ? `No offline shape for ${appId}/${entity}${purposeLabel}`
          : `Multiple offline shapes match ${appId}/${entity}${purposeLabel}; shapeId is required`,
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
      30_000,
    );
    this.#bootstrapRetryAttempt += 1;
    this.#bootstrapRetryTimer = setTimeout(() => {
      this.#bootstrapRetryTimer = undefined;
      void this.bootstrapWhenReachable();
    }, delay);
  }

  private resolveAdmissionWaiter(intentId: string, result: ShellReplicaWriteResult): void {
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
      this.resolveAdmissionWaiter(intentId, { intentId, status: 'queued', reason });
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
    while (this.#admissionRegistrationBarrier) {
      await this.#admissionRegistrationBarrier;
    }
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
    this.#eventTarget.removeEventListener('online', this.onOnline);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#bootstrapRetryTimer) clearTimeout(this.#bootstrapRetryTimer);
    this.#bootstrapRetryTimer = undefined;
    this.#drainRequested = false;
  }

  private assertOpen(): void {
    if (this.#closed) throw new ReplicaProtocolError('Replica session is closed');
  }
}

export async function openReplicaShellSession(
  gatewayAuth: GatewayAuth,
  options: OpenReplicaShellSessionOptions = {},
): Promise<ReplicaShellSession> {
  if (!gatewayAuth.vaultId) throw new ReplicaProtocolError('An addressed vault is required');
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const rememberRequested = gatewayAuth.rememberDevice === true;
  const remember = rememberRequested
    ? await prepareRememberedReplicaIdentity(identity, {
        ...(options.indexedDbFactory ? { indexedDbFactory: options.indexedDbFactory } : {}),
        ...(options.inventory ? { inventory: options.inventory } : {}),
      })
    : false;
  if (!rememberRequested) {
    await purgeRememberedReplicaIdentities((item) => sameIdentity(item, identity), {
      ...(options.indexedDbFactory ? { indexedDbFactory: options.indexedDbFactory } : {}),
      ...(options.inventory ? { inventory: options.inventory } : {}),
      purgeSelector: { kind: 'identity', ...identity },
    });
  }
  let session: ReplicaShellSession | undefined;
  let pendingBootstrap = false;
  let persistedShapeIds: readonly string[] = [];
  const fetcher = options.fetcher ?? fetchReplicaDefault;
  const { replica, status } = await createReplicaCoordinator(identity, remember, {
    ...(options.workerFactory ? { workerFactory: options.workerFactory } : {}),
    ...(options.intentStore ? { intentStore: options.intentStore } : {}),
    ...(options.indexedDbFactory ? { indexedDbFactory: options.indexedDbFactory } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    changeFeed: {
      subscribe: subscribeVaultChanges,
      setShapeIds: async (shapeIds) => {
        persistedShapeIds = [...shapeIds];
        await setVaultChangeShapeIds(persistedShapeIds);
      },
      resume: resumeVaultChanges,
    },
    pullChanges: async (cursor, signal) => {
      try {
        return await fetchReplicaChanges(gatewayAuth, cursor, signal, persistedShapeIds, fetcher);
      } catch (error) {
        if (isAuthorizationError(error) && session) revokeAndPurge(session);
        throw error;
      }
    },
    onCursorAdvanced: (cursor, schemaEpoch) => {
      void postReplicaCheckpoint(gatewayAuth, cursor, schemaEpoch, fetcher).catch((error) => {
        if (isAuthorizationError(error) && session) revokeAndPurge(session);
      });
    },
    onRebootstrapRequired: () => {
      if (session) session.requireBootstrap();
      else pendingBootstrap = true;
    },
  });
  const rememberStorage = remember && status.mode === 'opfs-sahpool';
  if (remember && !rememberStorage) {
    try {
      await unregisterRememberedReplicaIdentity(identity, {
        ...(options.indexedDbFactory ? { indexedDbFactory: options.indexedDbFactory } : {}),
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
    onAuthorizationRevoked: options.onAuthorizationRevoked ?? revokeSingleton,
  });
  await session.start(status);
  if (pendingBootstrap) session.requireBootstrap();
  return session;
}

let singleton:
  | { key: string; identity: ReplicaIdentity; promise: Promise<ReplicaShellSession> }
  | undefined;
let lifecycleInstalled = false;
let lifecyclePurge = Promise.resolve();
const terminalPurgeRetryLoop = new TerminalReplicaPurgeRetryLoop();

export async function getReplicaShellSession(): Promise<ReplicaShellSession> {
  installReplicaStorageLifecycle();
  const gatewayAuth = await auth();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const key = identityKey(identity);
  if (singleton?.key === key) return singleton.promise;
  if (singleton) await closeReplicaShellSession();
  const promise = openReplicaShellSession(gatewayAuth);
  singleton = { key, identity, promise };
  promise.catch(() => {
    if (singleton?.promise === promise) singleton = undefined;
  });
  return promise;
}

export async function purgeReplicaShellSession(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  if (!current) return;
  await current.promise
    .then((session) => session.purge())
    .catch(() => undefined)
    .finally(() => terminalPurgeRetryLoop.wake());
}

/** Eager local half of revoking the device that owns this renderer. */
export async function purgeCurrentReplicaDevice(): Promise<void> {
  purgeBrowserReplicaCaches();
  let identity: ReplicaIdentity | undefined;
  try {
    const gatewayAuth = await auth();
    if (gatewayAuth.vaultId) identity = replicaIdentityForGatewayAuth(gatewayAuth);
  } catch {
    // An open singleton still carries its identity and can purge itself below.
  }
  await purgeReplicaShellSession();
  try {
    if (identity) {
      await purgeRememberedReplicaIdentities((item) => sameIdentity(item, identity), {
        purgeSelector: { kind: 'identity', ...identity },
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Could not durably schedule remembered replica discovery'
    ) {
      throw error;
    }
    // The selector/terminal marker was written before deletion began. A
    // temporarily unavailable inventory is retried by the lifecycle loop.
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

/** Ordinary scope switches preserve remembered OPFS/IDB for a warm return. */
export async function closeReplicaShellSession(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  if (!current) return;
  await current.promise.then((session) => session.close()).catch(() => undefined);
}

export function installReplicaStorageLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  terminalPurgeRetryLoop.start();
  window.CentraidApi.onGatewayChanged?.((detail) => {
    queueLifecyclePurge(() => handleGatewayChanged(detail));
  });
  window.CentraidApi.onVaultChanged?.((detail) => {
    queueLifecyclePurge(() => handleVaultChanged(detail));
  });
}

interface GatewayChangedDetail {
  activeGatewayId: string;
  gatewayId?: string;
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
}

interface VaultChangedDetail {
  activeGatewayId: string;
  gatewayId?: string;
  activeVaultId?: string;
}

async function handleGatewayChanged(detail: GatewayChangedDetail): Promise<void> {
  const activeGatewayId = detail.gatewayId ?? detail.activeGatewayId;
  const purgeGatewayIds = new Set<string>();
  if (detail.removedGatewayId) purgeGatewayIds.add(detail.removedGatewayId);
  if (detail.purgeReplicaGatewayId) purgeGatewayIds.add(detail.purgeReplicaGatewayId);
  if (singleton) {
    if (purgeGatewayIds.has(singleton.identity.gatewayId)) {
      await purgeReplicaShellSession();
    } else if (singleton.identity.gatewayId !== activeGatewayId) {
      await closeReplicaShellSession();
    }
  }
  for (const gatewayId of purgeGatewayIds) {
    await purgeRememberedReplicaIdentities((identity) => identity.gatewayId === gatewayId, {
      purgeSelector: { kind: 'gateway', gatewayId },
    });
  }
}

async function handleVaultChanged(detail: VaultChangedDetail): Promise<void> {
  const gatewayId = detail.gatewayId ?? detail.activeGatewayId;
  const activeVaultId = detail.activeVaultId;
  if (
    singleton &&
    (singleton.identity.gatewayId !== gatewayId || singleton.identity.vaultId !== activeVaultId)
  ) {
    await purgeReplicaShellSession();
  }
  await purgeRememberedReplicaIdentities(
    (identity) => identity.gatewayId === gatewayId && identity.vaultId !== activeVaultId,
    {
      purgeSelector: {
        kind: 'inactive-vaults',
        gatewayId,
        ...(activeVaultId ? { activeVaultId } : {}),
      },
    },
  );
}

function queueLifecyclePurge(task: () => Promise<void>): void {
  lifecyclePurge = lifecyclePurge
    .then(task, task)
    .catch(() => undefined)
    .finally(() => terminalPurgeRetryLoop.wake());
}

function revokeSingleton(session: ReplicaShellSession): void {
  if (!singleton) return;
  void singleton.promise.then((active) => {
    if (active === session) singleton = undefined;
  });
}

function revokeAndPurge(session: ReplicaShellSession): void {
  revokeSingleton(session);
  purgeBrowserReplicaCaches();
  void purgeSessionTerminal(session);
}

async function purgeSessionTerminal(session: ReplicaShellSession): Promise<void> {
  try {
    await session.purge();
  } catch {
    await purgeReplicaIdentityStorage(replicaIdentityForGatewayAuth(session.gatewayAuth)).catch(
      () => undefined,
    );
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

/** The PWA service worker owns lazy blob/preview bytes for this device scope. */
function purgeBrowserReplicaCaches(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'centraid:purge-tunnel-cache' });
  } catch {
    /* Desktop and hardened browsers have no service-worker cache lane. */
  }
  try {
    if (typeof caches !== 'undefined') {
      void caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter(
                (name) =>
                  name.startsWith('centraid-tunnel-assets-') ||
                  name.startsWith('centraid-tunnel-blobs-'),
              )
              .map((name) => caches.delete(name)),
          ),
        )
        .catch(() => undefined);
    }
  } catch {
    /* Cache Storage may be denied even when the global is present. */
  }
}

export function replicaIdentityForGatewayAuth(gatewayAuth: GatewayAuth): ReplicaIdentity {
  if (!gatewayAuth.vaultId) throw new ReplicaProtocolError('An addressed vault is required');
  return {
    gatewayId: gatewayAuth.gatewayId?.trim() || normalizedGatewayUrl(gatewayAuth.baseUrl),
    vaultId: gatewayAuth.vaultId,
  };
}

function normalizedGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.toString()}`;
  } catch {
    return `url:${value.replace(/\/+$/, '')}`;
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

function fetchReplicaDefault(
  baseUrl: string,
  pathname: string,
  init: RequestInit,
): Promise<Response> {
  return doFetch(baseUrl, pathname, init);
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === 'auth_required';
}

function isTransientGatewayError(error: unknown): boolean {
  return (
    error instanceof GatewayClientError &&
    (error.code === 'gateway_unreachable' || error.code === 'gateway_error')
  );
}

function isPermanentIntentRejection(error: unknown): error is ReplicaTransportError {
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
  exact: readonly IntentOutcome[],
): IntentOutcome[] {
  const byId = new Map(baseline.map((outcome) => [outcome.intentId, outcome]));
  for (const outcome of exact) byId.set(outcome.intentId, outcome);
  return [...byId.values()];
}

function admissionResult(intent: ReplicaIntent): ShellReplicaWriteResult | undefined {
  if (intent.state === 'awaiting-change') {
    return { intentId: intent.intentId, status: 'in-flight' };
  }
  if (
    intent.state !== 'parked' &&
    intent.state !== 'executed' &&
    intent.state !== 'denied' &&
    intent.state !== 'failed'
  ) {
    return undefined;
  }
  return {
    intentId: intent.intentId,
    status: intent.state,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.output !== undefined ? { output: intent.output } : {}),
  };
}

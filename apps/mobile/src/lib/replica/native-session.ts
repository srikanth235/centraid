// governance: allow-repo-hygiene file-size-limit (#419) the native session is one cohesive coordinator wiring store, intent outbox, windowed bootstrap, SSE feed, and AppState drain across a single lifecycle
import {
  DEFAULT_REPLICA_PURPOSE,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
  runWindowedBootstrap,
  GatewayClientError,
  IntentQueue,
  postReplicaCheckpoint,
  postReplicaIntent,
  ReplicaCoordinator,
  ReplicaProtocolError,
  ReplicaTransportError,
  type EnqueueIntentInput,
  type GatewayAuth,
  type IntentOutcome,
  type OptimisticMutation,
  type ReplicaChangeFeedAdapter,
  type ReplicaCursor,
  type ReplicaDigest,
  type ReplicaFetcher,
  type ReplicaIdFactory,
  type ReplicaIntent,
  type ReplicaInvalidation,
  type ReplicaReadRequest,
  type ReplicaReadWireResult,
  type ReplicaSearchRequest,
  type ReplicaSearchWireResult,
  type ReplicaShape,
  type ReplicaSqliteDriver,
  type ReplicaStatus,
  type ReplicaValue,
  validateOptimisticMutation,
} from '@centraid/client/replica/native';

import { NativeReplicaStore } from './native-replica-store';
import { SqliteIntentStore } from './sqlite-intent-store';

export type NativeReadRequest = Omit<ReplicaReadRequest, 'shapeId'> & { shapeId?: string };
export type NativeSearchRequest = Omit<ReplicaSearchRequest, 'shapeId'> & { shapeId?: string };

export type NativeOptimisticMutation =
  | (Omit<Extract<OptimisticMutation, { op: 'upsert' }>, 'shapeId'> & {
      shapeId?: string;
      purpose?: string;
    })
  | (Omit<Extract<OptimisticMutation, { op: 'delete' }>, 'shapeId'> & {
      shapeId?: string;
      purpose?: string;
    });

export interface NativeWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: NativeOptimisticMutation[];
  intentId?: string;
}

export type NativeWriteResult =
  | IntentOutcome
  | { intentId: string; status: 'queued' | 'in-flight'; reason?: string };

/** AppState-shaped foreground signal; RN's `AppState` satisfies it. */
export interface AppStateLike {
  readonly currentState: string | null;
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
}

/** The change-feed adapter plus the session's foreground pause/resume control. */
export interface NativeChangeFeed extends ReplicaChangeFeedAdapter {
  setActive(active: boolean): void;
}

export interface CreateNativeReplicaSessionOptions {
  gatewayAuth: GatewayAuth;
  /** Non-streaming transport to the tunnel loopback proxy (`http://127.0.0.1:<port>`). */
  fetcher: ReplicaFetcher;
  changeFeed: NativeChangeFeed;
  /**
   * The SQLite driver backing both the replica store and the intent outbox.
   * Production passes `openNativeReplicaDriver(...)` (op-sqlite); tests pass a
   * `node:sqlite` stand-in. Injected rather than constructed here so this module
   * never imports the native op-sqlite binding.
   */
  driver: ReplicaSqliteDriver;
  appState?: AppStateLike;
  isConnected?: () => boolean;
  retryDelayMs?: number;
  /**
   * Hermes has no WebCrypto. These default to the `expo-crypto` implementations
   * in `./native-hash`, imported lazily so a node test can inject its own and
   * never load an Expo native module.
   */
  digest?: ReplicaDigest;
  idFactory?: ReplicaIdFactory;
  /**
   * Rows per bootstrap page. Native bootstraps windowed by default: a 50k+ asset
   * library cannot land in one JSON envelope (the single-shot route 413s).
   */
  bootstrapWindow?: number;
}

interface Waiter {
  resolve(result: NativeWriteResult): void;
  reject(error: unknown): void;
}

/**
 * Headless single-process replica session for React Native. Wires the op-sqlite
 * store, the SQLite intent outbox, a `ReplicaCoordinator` and the HTTP transport
 * into: foreground delta pulls (on AppState active and on connect), an SSE feed
 * while active, feed teardown on background, and a rebootstrap flow that survives
 * without dropping queued intents. Exposes the read/search/write/subscribe
 * surface a future Photos UI consumes — no web admission barrier or
 * storage-manifest machinery.
 */
export class NativeReplicaSession {
  readonly #coordinator: ReplicaCoordinator;
  readonly #gatewayAuth: GatewayAuth;
  readonly #fetcher: ReplicaFetcher;
  readonly #feed: NativeChangeFeed;
  readonly #appState: AppStateLike | undefined;
  readonly #isConnected: () => boolean;
  readonly #retryDelayMs: number;
  readonly #bootstrapWindow: number | undefined;
  readonly #waiters = new Map<string, Set<Waiter>>();
  #catalog: ReplicaShape[] = [];
  #hasCursor = false;
  #bootstrapPromise: Promise<void> | undefined;
  #drainPromise: Promise<void> | undefined;
  #drainRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #appStateSub: { remove(): void } | undefined;
  #closed = false;

  constructor(
    coordinator: ReplicaCoordinator,
    options: Pick<
      CreateNativeReplicaSessionOptions,
      | 'gatewayAuth'
      | 'fetcher'
      | 'changeFeed'
      | 'appState'
      | 'isConnected'
      | 'retryDelayMs'
      | 'bootstrapWindow'
    >,
  ) {
    this.#coordinator = coordinator;
    this.#gatewayAuth = options.gatewayAuth;
    this.#fetcher = options.fetcher;
    this.#feed = options.changeFeed;
    this.#appState = options.appState;
    this.#isConnected = options.isConnected ?? (() => true);
    this.#retryDelayMs = options.retryDelayMs ?? 2_000;
    this.#bootstrapWindow = options.bootstrapWindow;
  }

  get coordinator(): ReplicaCoordinator {
    return this.#coordinator;
  }

  async start(): Promise<this> {
    const status = await this.#coordinator.status();
    await this.#coordinator.recoverSending();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) this.#catalog = await this.#coordinator.catalog();
    else await this.bootstrapWhenReachable();
    const foreground = this.#appState ? this.#appState.currentState !== 'background' : true;
    this.#feed.setActive(foreground);
    if (this.#appState) {
      this.#appStateSub = this.#appState.addEventListener('change', this.onAppStateChange);
    }
    void this.flushIntents();
    return this;
  }

  async read(appId: string, request: NativeReadRequest): Promise<ReplicaReadWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId, request.purpose);
    return this.#coordinator.readWire({ ...request, shapeId });
  }

  async search(appId: string, request: NativeSearchRequest): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId, request.purpose);
    return this.#coordinator.searchWire({ ...request, shapeId });
  }

  async write(appId: string, input: NativeWriteInput): Promise<NativeWriteResult> {
    this.assertOpen();
    if (!input.action) throw new ReplicaProtocolError('Replica action is required');
    const optimistic = (input.optimistic ?? []).map((mutation) => {
      const { purpose, shapeId, ...rest } = mutation;
      return { ...rest, shapeId: this.resolveShapeId(appId, mutation.entity, shapeId, purpose) };
    }) as OptimisticMutation[];
    // Validate at enqueue time exactly as the web shell session does. The native
    // write path never re-checked, so an invalid optimistic mutation (e.g. a
    // synthetic __rowId column spread into the values) was silently dropped by
    // applyOptimisticMutations and the edit simply never rendered. Reject loudly.
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
    const intent = await this.#coordinator.enqueue({
      ...(input.intentId ? { intentId: input.intentId } : {}),
      appId,
      action: input.action,
      input: input.input,
      optimistic,
      dependencies,
    } satisfies EnqueueIntentInput);
    const settled = terminalResult(intent);
    if (settled) return settled;
    if (!this.#isConnected()) {
      return { intentId: intent.intentId, status: 'queued', reason: 'waiting for a connection' };
    }
    const admitted = new Promise<NativeWriteResult>((resolve, reject) => {
      const waiters = this.#waiters.get(intent.intentId) ?? new Set<Waiter>();
      waiters.add({ resolve, reject });
      this.#waiters.set(intent.intentId, waiters);
    });
    void this.flushIntents();
    return admitted;
  }

  subscribe(
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void,
  ): () => void {
    this.assertOpen();
    return this.#coordinator.subscribeInvalidations((invalidations) => {
      const appShapes = new Set(
        this.#catalog.filter((shape) => shape.appId === appId).map((shape) => shape.shapeId),
      );
      const relevant = invalidations.filter(
        (invalidation) => invalidation.source === 'purge' || appShapes.has(invalidation.shapeId),
      );
      if (relevant.length > 0) listener(relevant.map((entry) => ({ ...entry })));
    });
  }

  status(): Promise<ReplicaStatus> {
    return this.#coordinator.status();
  }

  catalog(): readonly ReplicaShape[] {
    return this.#catalog;
  }

  /** Wake the one coordinator after the platform reports connectivity. */
  notifyReachable(): void {
    if (!this.#isConnected() || this.#closed) return;
    if (!this.#hasCursor) void this.bootstrapWhenReachable();
    else void this.pullNow().catch(() => undefined);
    void this.flushIntents();
  }

  /** Replace an ephemeral loopback tunnel URL after process restart/reconnect. */
  updateGatewayBase(baseUrl: string): void {
    if (this.#closed || this.#gatewayAuth.baseUrl === baseUrl) return;
    this.#gatewayAuth.baseUrl = baseUrl;
    const foreground = this.#appState ? this.#appState.currentState !== 'background' : true;
    this.#feed.setActive(false);
    if (foreground) this.#feed.setActive(true);
  }

  async flushIntents(): Promise<void> {
    if (this.#closed || !this.#isConnected()) return;
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

  /** Force a foreground delta pull immediately (e.g. on manual refresh). */
  async pullNow(): Promise<void> {
    if (this.#closed || !this.#isConnected() || !this.#hasCursor) return;
    const status = await this.#coordinator.status();
    if (!status.cursor) return;
    const abort = new AbortController();
    const batch = await this.pullChanges(status.cursor, abort.signal);
    if (batch) await this.#coordinator.applyChanges(batch);
  }

  requireBootstrap(): void {
    this.#hasCursor = false;
    if (!this.#closed) void this.bootstrapWhenReachable();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.#feed.setActive(false);
    this.rejectWaiters(new ReplicaProtocolError('Replica session closed'));
    await this.#coordinator.close();
  }

  private readonly onAppStateChange = (state: string): void => {
    if (this.#closed) return;
    if (state === 'active') {
      this.#feed.setActive(true);
      if (!this.#hasCursor) void this.bootstrapWhenReachable();
      else void this.pullNow().catch(() => undefined);
      void this.flushIntents();
    } else if (state === 'background') {
      this.#feed.setActive(false);
    }
  };

  private async bootstrapWhenReachable(): Promise<void> {
    if (this.#bootstrapPromise || this.#closed || !this.#isConnected())
      return this.#bootstrapPromise;
    this.#bootstrapPromise = this.bootstrap().finally(() => {
      this.#bootstrapPromise = undefined;
    });
    return this.#bootstrapPromise;
  }

  /**
   * Windowed bootstrap. `runWindowedBootstrap` owns the page walk, the commit at
   * the page-1 cursor and the mandatory convergence replay; the replica only
   * reports a cursor once all of that has succeeded.
   */
  private async bootstrap(): Promise<void> {
    const resolved: IntentOutcome[] = [];
    await runWindowedBootstrap({
      gatewayAuth: this.#gatewayAuth,
      target: this.#coordinator,
      fetcher: this.#fetcher,
      ...(this.#bootstrapWindow !== undefined ? { window: this.#bootstrapWindow } : {}),
      reconcileOutcomes: async (cursor) => {
        const pending = await this.#coordinator.pendingIntents();
        const exact = await fetchReplicaIntentOutcomes(
          this.#gatewayAuth,
          pending.map((intent) => intent.intentId),
          cursor,
          this.#fetcher,
        );
        resolved.push(...exact);
        return exact;
      },
      pullChanges: async (cursor, signal) => {
        const shapeIds = (await this.#coordinator.catalog()).map((shape) => shape.shapeId);
        return fetchReplicaChanges(this.#gatewayAuth, cursor, signal, shapeIds, this.#fetcher);
      },
    });
    this.#hasCursor = true;
    this.#catalog = await this.#coordinator.catalog();
    for (const outcome of resolved) this.resolveWaiter(outcome.intentId, outcome);
  }

  private pullChanges = (cursor: ReplicaCursor, signal: AbortSignal) => {
    const shapeIds = this.#catalog.map((shape) => shape.shapeId);
    return fetchReplicaChanges(this.#gatewayAuth, cursor, signal, shapeIds, this.#fetcher);
  };

  private async drainLoop(): Promise<void> {
    while (!this.#closed && this.#isConnected()) {
      let intent: ReplicaIntent | undefined;
      try {
        intent = await this.#coordinator.claimNextIntent();
      } catch (error) {
        this.rejectWaiters(error);
        return;
      }
      if (!intent) return;
      try {
        const { outcome } = await postReplicaIntent(this.#gatewayAuth, intent, this.#fetcher);
        if (outcome.status === 'executed' || outcome.status === 'in-flight') {
          await this.#coordinator.markIntentAwaitingChange(intent.intentId);
        } else {
          await this.#coordinator.applyIntentOutcome(outcome);
        }
        this.resolveWaiter(intent.intentId, outcome);
      } catch (error) {
        if (isAuthorizationError(error)) {
          this.rejectWaiter(intent.intentId, error);
          this.requireBootstrap();
          return;
        }
        if (isPermanentIntentRejection(error)) {
          const outcome: IntentOutcome = {
            intentId: intent.intentId,
            status: error.status === 403 ? 'denied' : 'failed',
            reason: error.message,
          };
          await this.#coordinator.applyIntentOutcome(outcome);
          this.resolveWaiter(intent.intentId, outcome);
          continue;
        }
        await this.#coordinator
          .markIntentTransportFailed(intent.intentId, errorMessage(error))
          .catch(() => undefined);
        this.resolveWaiter(intent.intentId, {
          intentId: intent.intentId,
          status: 'queued',
          reason: 'saved locally; retrying when the gateway is reachable',
        });
        this.scheduleRetry();
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushIntents();
    }, this.#retryDelayMs);
  }

  private resolveWaiter(intentId: string, result: NativeWriteResult): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    for (const waiter of waiters) waiter.resolve({ ...result } as NativeWriteResult);
  }

  private rejectWaiter(intentId: string, error: unknown): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    for (const waiter of waiters) waiter.reject(error);
  }

  private rejectWaiters(error: unknown): void {
    // Snapshot the ids first: rejectWaiter deletes from the map as it resolves.
    const intentIds = Array.from(this.#waiters.keys());
    for (const intentId of intentIds) this.rejectWaiter(intentId, error);
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
        throw new ReplicaProtocolError(`Shape ${requested} is not available to app ${appId}`);
      }
      return requested;
    }
    if (candidates.length !== 1) {
      throw new ReplicaProtocolError(
        candidates.length === 0
          ? `No offline shape for ${appId}/${entity}`
          : `Multiple offline shapes match ${appId}/${entity}; shapeId is required`,
      );
    }
    return candidates[0]!.shapeId;
  }

  private assertOpen(): void {
    if (this.#closed) throw new ReplicaProtocolError('Replica session is closed');
  }
}

/**
 * Open a native replica session: build the store + intent outbox over one
 * op-sqlite handle (or an injected driver), wire the coordinator to the change
 * feed and transport, and start the sync loop.
 */
export async function createNativeReplicaSession(
  options: CreateNativeReplicaSessionOptions,
): Promise<NativeReplicaSession> {
  if (!options.gatewayAuth.vaultId) {
    throw new ReplicaProtocolError('An addressed vault is required');
  }
  const store = NativeReplicaStore.create(options.driver, options.gatewayAuth.vaultId);
  const intentStore = SqliteIntentStore.create(options.driver);
  const feed = options.changeFeed;
  // Loaded only when the caller supplies neither, so `node:test` runs (which
  // inject both) never resolve expo-crypto's native module.
  const crypto = options.digest && options.idFactory ? undefined : await import('./native-hash');
  const intents = new IntentQueue(intentStore, {
    digest: options.digest ?? crypto!.nativeReplicaDigest,
    idFactory: options.idFactory ?? crypto!.nativeReplicaIdFactory,
  });
  let session: NativeReplicaSession | undefined;
  const coordinator = new ReplicaCoordinator(store, intents, {
    changeFeed: feed,
    pullChanges: (cursor, signal) => {
      const shapeIds = (session?.catalog() ?? []).map((shape) => shape.shapeId);
      return fetchReplicaChanges(options.gatewayAuth, cursor, signal, shapeIds, options.fetcher);
    },
    onCursorAdvanced: (cursor, schemaEpoch) => {
      void postReplicaCheckpoint(options.gatewayAuth, cursor, schemaEpoch, options.fetcher).catch(
        () => undefined,
      );
    },
    onRebootstrapRequired: () => session?.requireBootstrap(),
  });
  session = new NativeReplicaSession(coordinator, options);
  await session.start();
  return session;
}

function terminalResult(intent: ReplicaIntent): NativeWriteResult | undefined {
  if (intent.state === 'awaiting-change') return { intentId: intent.intentId, status: 'in-flight' };
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

function isAuthorizationError(error: unknown): boolean {
  return error instanceof GatewayClientError && error.code === 'auth_required';
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

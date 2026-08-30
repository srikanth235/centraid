import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
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
  ReplicaValue,
  ReplicaWriteMutationInput,
} from "@centraid/client/replica/native";
import { appActionPath } from "@centraid/core/protocol";

import { backoffSchedule } from "../backoff";
import type { BackoffSchedule } from "../backoff";
import { MobileIntentIds } from "./mobile-intent-id";
import { NativeReplicaStore } from "./native-replica-store";
import { isReplicaStorageFullError } from "./replica-storage-error";
import { SqliteIntentStore } from "./sqlite-intent-store";
import type { NativeIntentAttention } from "./sqlite-intent-store";

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
  /**
   * THE ONLINE-ONLY DOOR (blueprint-seats contract H; docs/mobile-offline.md).
   *
   * A sealed input must never cross the durable session boundary: the outbox
   * outlives the process, and a secret that reaches it has left the memory-only
   * world the app promised. `true` sends the action straight to the gateway and
   * NEVER enqueues — a transport failure surfaces as a failure, because falling
   * back to the queue is precisely the thing this flag forbids.
   *
   * The browser seat's counterpart is `centraid-inline.ts`'s `opts.onlineOnly`;
   * the action list is `apps/locker/writes.ts` `ONLINE_ONLY_ACTIONS`.
   */
  onlineOnly?: boolean;
}

export type NativeWriteResult =
  | IntentOutcome
  | { intentId: string; status: "queued" | "in-flight"; reason?: string };

/** Structural surface consumed by mobile app features across one or N vaults. */
export interface MobileReplicaSession {
  read: (
    appId: string,
    request: NativeReadRequest
  ) => Promise<ReplicaReadWireResult>;
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
  /** Rebuild the local replica from the gateway's current snapshot. */
  rebootstrap?: () => Promise<void>;
}

/** AppState-shaped foreground signal; RN's `AppState` satisfies it. */
export interface AppStateLike {
  readonly currentState: string | null;
  addEventListener: (
    type: "change",
    handler: (state: string) => void
  ) => { remove: () => void };
}

/** The change-feed adapter plus the session's foreground pause/resume control. */
export interface NativeChangeFeed extends ReplicaChangeFeedAdapter {
  setActive: (active: boolean) => void;
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
  isNetworkWorkAllowed?: () => Promise<boolean>;
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
  /**
   * Return from `start()` once page one is durable and readable, then backfill
   * in the background. Foreground mobile sessions enable this; headless jobs
   * and compatibility callers wait for convergence.
   */
  progressiveBootstrap?: boolean;
  onBootstrapProgress?: (progress: {
    phase: "first-page" | "backfill" | "complete";
    pages: number;
  }) => void;
  /**
   * The device ran out of room and the coordinator parked the feed. Fires once
   * per pause, so the mounting surface can raise `out of room` without polling.
   */
  onStorageFull?: (error: unknown) => void;
}

/**
 * Retry ceiling: five minutes keeps a phone that lost coverage overnight at a
 * dozen wake-ups, not thousands. Reconnect, foreground and a new write each
 * reset the sequence, so nothing waits this long once the gateway answers.
 */
const MAX_INTENT_RETRY_DELAY_MS = 5 * 60_000;

interface Waiter {
  resolve: (result: NativeWriteResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Headless single-process replica session for React Native. Wires the op-sqlite
 * store, the SQLite intent outbox, a `ReplicaCoordinator` and the HTTP transport
 * into: foreground delta pulls (on AppState active and on connect), an SSE feed
 * while active, feed teardown on background, and a rebootstrap flow that survives
 * without dropping queued intents.
 */
export class NativeReplicaSession implements MobileReplicaSession {
  readonly #coordinator: ReplicaCoordinator;
  readonly #gatewayAuth: GatewayAuth;
  readonly #fetcher: ReplicaFetcher;
  readonly #feed: NativeChangeFeed;
  readonly #appState: AppStateLike | undefined;
  readonly #isConnected: () => boolean;
  readonly #retryBackoff: BackoffSchedule;
  readonly #isNetworkWorkAllowed: () => Promise<boolean>;
  readonly #bootstrapWindow: number | undefined;
  readonly #progressiveBootstrap: boolean;
  readonly #intentStore: SqliteIntentStore;
  readonly #intentIds: MobileIntentIds;
  readonly #onBootstrapProgress:
    | CreateNativeReplicaSessionOptions["onBootstrapProgress"]
    | undefined;
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
      | "retryDelayMs"
      | "bootstrapWindow"
      | "progressiveBootstrap"
      | "onBootstrapProgress"
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
    const baseMs = options.retryDelayMs ?? 2_000;
    this.#retryBackoff = backoffSchedule({
      baseMs,
      maxMs: Math.max(baseMs, MAX_INTENT_RETRY_DELAY_MS),
      jitter: 0.2,
    });
    this.#intentIds = new MobileIntentIds(options.idFactory);
    this.#bootstrapWindow = options.bootstrapWindow;
    this.#progressiveBootstrap = options.progressiveBootstrap ?? false;
    this.#onBootstrapProgress = options.onBootstrapProgress;
  }

  get coordinator(): ReplicaCoordinator {
    return this.#coordinator;
  }

  /** True while this scope's sync is parked for lack of device storage. */
  get storageFull(): boolean {
    return this.#coordinator.storageFull;
  }

  /** Space was freed on the phone: unpark the feed for this scope. */
  resumeAfterStorageFull(): void {
    this.#coordinator.resumeAfterStorageFull();
  }

  async start(): Promise<this> {
    const status = await this.#coordinator.status();
    await this.#coordinator.recoverSending();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) this.#catalog = await this.#coordinator.catalog();
    if (
      (status.coverage === "partial" ||
        (status.cursor === null && status.coverage !== "complete")) &&
      this.#isConnected() &&
      (await this.#isNetworkWorkAllowed())
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
    // Before ANY projection, id minting or queue touch: an online-only write
    // has no representation in the outbox at all.
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
    // On a first-open offline launch there is no replica catalog to validate
    // the optimistic row against. Preserve the durable action intent and defer
    // only its projection until canonical bootstrap data arrives.
    const { optimistic, dependencies } =
      this.#catalog.length === 0
        ? { optimistic: [], dependencies: [] }
        : prepareReplicaWrite(
            appId,
            input.optimistic ?? projected.optimistic,
            this.#catalog,
            this.resolveShapeId.bind(this),
            false
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
    const settled = terminalResult(intent);
    if (settled) return settled;
    if (!this.#isConnected()) {
      return {
        intentId: intent.intentId,
        status: "queued",
        reason: "waiting for a connection",
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

  /**
   * The online-only transport. One POST to the app's own action handler,
   * carrying the addressed vault, and no durable trace of the payload on this
   * device: no intent id, no optimistic projection, no outbox row. The result
   * is `executed` or it throws — there is deliberately no `queued` branch.
   */
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
    // The id is local and disposable: nothing persisted it, and no later
    // outcome will arrive quoting it. It exists so the one write-outcome
    // surface (`kit/replica/write-outcome.ts`) takes the same shape here.
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

  /** `attempts` and `enqueuedAt` are what separate "sending" from "stuck". */
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
          /** Conflict only: the two versions the overlay copy prints. */
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

  /** A member's own cancel retires the intent; only a gateway denial is retained. */
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

  /** Wake the one coordinator after the platform reports connectivity. */
  notifyReachable(): void {
    if (!this.#isConnected() || this.#closed) return;
    this.resetRetry();
    if (this.#hasCursor) {
      void this.pullNow().catch(() => undefined);
    } else {
      void this.bootstrapWhenReachable();
    }
    void this.flushIntents();
  }

  /** Replace an ephemeral loopback tunnel URL after process restart/reconnect. */
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
      // A paused drain must not hang an awaited write(); the intent is durable.
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

  /** Force a foreground delta pull immediately (e.g. on manual refresh). */
  async pullNow(): Promise<boolean> {
    if (this.#closed || !this.#isConnected() || !this.#hasCursor) return false;
    if (!(await this.#isNetworkWorkAllowed())) return false;
    const status = await this.#coordinator.status();
    if (!status.cursor) return false;
    const abort = new AbortController();
    const started = Date.now();
    let cursor = status.cursor;
    let batches = 0;
    while (cursor && batches < 32 && Date.now() - started < 5_000) {
      // Each request must use the cursor returned by the previous apply;
      // concurrent pulls would race and make the cursor merge ambiguous.
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

  requireBootstrap(): void {
    this.#hasCursor = false;
    if (!this.#closed) void this.bootstrapWhenReachable();
  }

  /** Force a full snapshot when a write is intentionally outside the feed. */
  async rebootstrap(): Promise<void> {
    if (this.#closed) return;
    this.#hasCursor = false;
    // Progressive bootstrap resolves after page one while its backfill can
    // still be running. A refresh requested from that preview supersedes the
    // stale pre-write walk: cancel it, wait for its store cleanup, then start
    // the new snapshot. Waiting for a large stale walk here can otherwise keep
    // an intentional out-of-feed write invisible for minutes on mobile.
    const inFlight = this.#bootstrapPromise;
    if (inFlight) {
      this.#bootstrapAbort?.abort();
      await inFlight.catch(() => undefined);
    }
    if (this.#closed) return;
    // This is an explicit rebuild requested after an online operation. The
    // reachability flag is deliberately advisory and can lag the tunnel that
    // just accepted that operation; the fetcher is the authority here. Keep
    // the transfer-policy gate in bootstrapWhenReachable(), but do not drop a
    // successful seed merely because the provider has not published `online`
    // yet.
    this.#hasCursor = false;
    if (!(await this.#isNetworkWorkAllowed())) return;
    if (this.#bootstrapPromise) return this.#bootstrapPromise;
    this.#bootstrapPromise = this.bootstrap().finally(() => {
      this.#bootstrapPromise = undefined;
    });
    await this.#bootstrapPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
    this.#feed.setActive(false);
    this.rejectWaiters(new ReplicaProtocolError("Replica session closed"));
    this.#bootstrapAbort?.abort();
    await this.#bootstrapPromise?.catch(() => undefined);
    await this.#coordinator.close();
  }

  /** Membership revocation: close and delete this scope's rows and intents. */
  async purge(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
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
        void this.bootstrapWhenReachable();
      }
      void this.flushIntents();
    } else if (state === "background") {
      this.#feed.setActive(false);
    }
  };

  private async bootstrapWhenReachable(): Promise<void> {
    if (this.#bootstrapPromise || this.#closed || !this.#isConnected())
      return this.#bootstrapPromise;
    if (!(await this.#isNetworkWorkAllowed())) return;
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
        // The gateway answered, so whatever the outage was is over.
        this.#retryBackoff.reset();
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

  /**
   * Something changed that could make the next attempt succeed — a reconnect, a
   * foreground, a fresh write — so the drainer should not keep waiting out an
   * outage-length delay.
   */
  private resetRetry(): void {
    this.#retryBackoff.reset();
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

  /** A durable admission is an honest settlement; an unresolved promise is not. */
  private settleWaitersAsQueued(reason: string): void {
    for (const intentId of Array.from(this.#waiters.keys()))
      this.resolveWaiter(intentId, { intentId, status: "queued", reason });
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

/**
 * Open a native replica session: build the store + intent outbox over one
 * op-sqlite handle (or an injected driver), wire the coordinator to the change
 * feed and transport, and start the sync loop.
 */
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
  // Loaded only when the caller supplies neither, so `node:test` runs (which
  // inject both) never resolve expo-crypto's native module.
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
    // Startup's handoff writes an attention row with no member gesture behind
    // it to dismiss.
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
    onRebootstrapRequired: () => session?.requireBootstrap(),
    // The op-sqlite taxonomy, not the normalized-name default: the driver
    // raises the platform's own SQLITE_FULL/ENOSPC shapes, and only this
    // classifier recognises all of them (./replica-storage-error).
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

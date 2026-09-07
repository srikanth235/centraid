import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";
// governance: allow-repo-hygiene file-size-limit (#419) the native session is one cohesive coordinator wiring store, intent outbox, windowed bootstrap, SSE feed, and AppState drain across a single lifecycle
import {
  authHeaders,
  fetchReplicaChanges,
  fetchReplicaIntentOutcomes,
  runWindowedBootstrap,
  GatewayClientError,
  admissionDuringRebootstrap,
  chainBadgeCopy,
  chainHolds,
  IntentQueue,
  postReplicaCheckpoint,
  postReplicaIntent,
  ReplicaCoordinator,
  ReplicaProtocolError,
  ReplicaTransportError,
  prepareReplicaWrite,
  reconstructPendingProjection,
  VAULT_HEADER,
} from "@centraid/client/replica/native";
import type {
  EnqueueIntentInput,
  GatewayAuth,
  IntentOutcome,
  IntentState,
  OptimisticMutation,
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
import { NativeReplicaStore } from "./native-replica-store";
import {
  forgetPendingContentRefs,
  publishPendingContentRefs,
} from "./pending-content-refs";
import { isReplicaStorageFullError } from "./replica-storage-error";
import { noteResyncVerdict } from "./resync-notice";
import { SqliteIntentStore } from "./sqlite-intent-store";
import type { NativeIntentAttention } from "./sqlite-intent-store";
import { stampVaultSourceRows } from "./vault-source";
import type { VaultSource } from "./vault-source";
import { waitingOnLabel } from "./waiting-on";
import type { MountedOrigin } from "./waiting-on";

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
   * The online-only door (blueprint-seats contract H; docs/mobile-offline.md).
   * A sealed input must never reach the outbox, which outlives the process.
   * `true` goes straight to the gateway and NEVER enqueues; a transport failure
   * surfaces as a failure, since the queue fallback is what this forbids.
   */
  onlineOnly?: boolean;
}

export type NativeWriteResult =
  | IntentOutcome
  | { intentId: string; status: "queued" | "in-flight"; reason?: string };

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
  subscribe: (
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ) => () => void;
  pullNow: () => Promise<void | boolean>;
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
  /** Injected, never constructed here, so this module never imports expo-sqlite. */
  driver: ReplicaSqliteDriver;
  /**
   * The one vault this session holds (#996 wave 3). Every row it hands back is
   * stamped with it, because "which vault, and may I write there" is what the
   * screens ask about a row — it just has one answer now that a seat opens one
   * file. Absent leaves rows unstamped, which reads as writable.
   */
  scope?: VaultSource;
  appState?: AppStateLike;
  isConnected?: () => boolean;
  isNetworkWorkAllowed?: () => Promise<boolean>;
  isRowSyncAllowed?: () => Promise<boolean>;
  retryDelayMs?: number;
  /**
   * Hermes has no WebCrypto; these default to `./native-hash` (expo-crypto),
   * imported lazily so an injecting test never loads an Expo native module.
   */
  digest?: ReplicaDigest;
  idFactory?: ReplicaIdFactory;
  /**
   * Rows per bootstrap page. Native bootstraps windowed by default: a 50k+ asset
   * library cannot land in one JSON envelope (the single-shot route 413s).
   */
  bootstrapWindow?: number;
  /**
   * Return from `start()` once page one is durable, then backfill behind it.
   * Headless jobs leave it off and wait for convergence.
   */
  progressiveBootstrap?: boolean;
  onBootstrapProgress?: (progress: {
    phase: "first-page" | "backfill" | "complete";
    pages: number;
  }) => void;
  /** Fires once per storage-full pause, so the mount need not poll. */
  onStorageFull?: (error: unknown) => void;
  onGatewayOutcome?: (reachable: boolean) => void;
  /**
   * Who a queued write into THIS vault may wait for. Set only where
   * `ReplicaVaultScope.personal === false`; absent means the member's own
   * vault, where a write waits for nobody and naming an owner would be
   * fiction.
   */
  origin?: MountedOrigin;
}

/** Ceiling, not the usual wait: reconnect, foreground and writes all reset. */
const MAX_INTENT_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Deliberately not `waiting for a connection`: that row is drawn and merely
 * unsent, while this one cannot be drawn at all until the shape catalog lands
 * with bootstrap page one (docs/mobile-offline.md: absent is never empty).
 */
export const NOT_YET_SYNCED =
  "Saved on this phone; it appears here once this vault finishes its first sync.";

interface Waiter {
  resolve: (result: NativeWriteResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Headless single-process replica session for React Native: store, intent
 * outbox, coordinator and transport wired into foreground delta pulls, an SSE
 * feed while active, teardown on background, and a rebootstrap that keeps
 * queued intents.
 */
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
  /**
   * A re-bootstrap is being prepared or is running (#996 R23/R25).
   *
   * `admissionDuringRebootstrap` is the rule: a write is ADMITTED — refusing
   * would make "saved" untrue during a repair the member did not ask for and
   * cannot see — and it is NOT SENT, because the cursor is about to move
   * discontinuously and an outcome arriving mid-swap would be reconciled
   * against a copy that no longer exists.
   */
  #rebootstrapping = false;
  readonly #intentIds: MobileIntentIds;
  readonly #onBootstrapProgress:
    | CreateNativeReplicaSessionOptions["onBootstrapProgress"]
    | undefined;
  readonly #waitingOnLabel: string | undefined;
  readonly #scope: VaultSource | undefined;
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
      | "origin"
      | "scope"
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
    this.#waitingOnLabel = options.origin
      ? waitingOnLabel(options.origin.displayName)
      : undefined;
    this.#scope = options.scope;
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
    await this.publishProtectedContent();
    this.#hasCursor = status.cursor !== null;
    if (status.cursor) {
      this.#catalog = await this.#coordinator.catalog();
      // A relaunch after a first-open write: the catalog is durable now, and
      // the intent that was admitted without one is still waiting to be drawn.
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
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId);
    const result = await this.#coordinator.readWire({ ...request, shapeId });
    return this.#scope ? stampVaultSourceRows(result, this.#scope) : result;
  }

  async search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    const shapeId = this.resolveShapeId(appId, request.entity, request.shapeId);
    const result = await this.#coordinator.searchWire({ ...request, shapeId });
    return this.#scope ? stampVaultSourceRows(result, this.#scope) : result;
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
    // #922 G2: the row id no longer spells which intent minted it, so the
    // OUTBOX answers instead — exact, and it works for an id the origin has
    // already honoured too.
    const retainedIntent = await this.#coordinator.pendingIntentForInput(
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
    // The ids the projection minted ride the write (#922 G2).
    const minted = projected.input
      ? ({
          ...(input.input as Readonly<Record<string, unknown>>),
          ...projected.input,
        } as typeof input.input)
      : input.input;
    // No catalog yet (first-open offline launch): keep the durable intent, defer
    // only its projection, and RECORD the deferral so
    // `backfillDeferredProjections` can finish it when page one lands.
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
      minted,
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
      input: minted,
      optimistic,
      dependencies,
      ...(this.#waitingOnLabel ? { stewardLabel: this.#waitingOnLabel } : {}),
      ...(baseVersions.length > 0 ? { baseVersions } : {}),
    } satisfies EnqueueIntentInput);
    // Absent is never empty: a deferred act is durable yet draws nothing, so it
    // says so rather than borrowing the ordinary offline sentence.
    if (deferred) await this.markDeferred(intent);
    // NOT AWAITED, and that is load-bearing: every await between the enqueue
    // and the waiter registration below is a window in which the drain can
    // settle this intent before anything is listening, and the caller's
    // `write()` then never resolves.
    void this.publishProtectedContent();
    const settled = terminalResult(intent);
    if (settled) return settled;
    if (!this.#isConnected()) {
      // Awaited on THIS path only: no waiter is registered here, so there is
      // no race to widen, and an offline write is exactly the one whose bytes
      // must be protected before the caller can act on the answer.
      await this.publishProtectedContent();
      return {
        intentId: intent.intentId,
        status: "queued",
        // Both are true; say the one that explains the missing row.
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

  /** Keep the prepared write shape stable; the waiting steward is intent metadata. */
  private stamped(prepared: PreparedReplicaWrite): PreparedReplicaWrite {
    return prepared;
  }

  /** Say the durable act is unrendered, on the row itself, until it is not. */
  private async markDeferred(intent: ReplicaIntent): Promise<void> {
    await this.#intentStore
      .transition(intent.intentId, [intent.state], { reason: NOT_YET_SYNCED })
      .catch(() => undefined);
  }

  /**
   * Project the intents admitted with no catalog, once page one lands (#883
   * D1). Patches the SAME intent through the outbox's atomic transition — id,
   * payload hash and queue position untouched, so an in-flight `write()` still
   * settles on it. Idempotent: an intent with a projection is skipped.
   */
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
        // Still durable, still sends; a shape this grant lacks never draws.
        continue;
      }
      // Sequential: each transition is a durable state move on one outbox.
      // oxlint-disable-next-line no-await-in-loop
      await this.#intentStore
        .transition(intent.intentId, [intent.state], {
          optimistic: prepared.optimistic,
          dependencies: prepared.dependencies,
          // The row draws itself now, so the sentence that stood in for it goes.
          ...(intent.reason === NOT_YET_SYNCED ? { reason: undefined } : {}),
        })
        .catch(() => undefined);
    }
  }

  /**
   * The online-only transport: no durable trace of the payload on this device —
   * no intent id, no projection, no outbox row — and `executed` or throw, with
   * deliberately no `queued` branch.
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
    // Local and disposable: nothing persisted it and no outcome will quote it.
    // It exists so `kit/replica/write-outcome.ts` sees one shape.
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

  /** The one vault this session holds, or `undefined` for an unscoped test session. */
  scope(): VaultSource | undefined {
    return this.#scope;
  }

  /**
   * The overlay a restart rebuilds, in outbox order (R23).
   *
   * Derived from the durable outbox rather than held in component state,
   * because a projection that lives in a component is one that vanishes with
   * the process — which is exactly the moment a member most needs to see that
   * the work they did offline is still there.
   */
  async pendingProjection(): Promise<OptimisticMutation[]> {
    return reconstructPendingProjection(
      await this.#coordinator.pendingIntents()
    );
  }

  /** `attempts` and `enqueuedAt` are what separate "sending" from "stuck". */
  async pendingChanges(): Promise<
    Array<
      | {
          intentId: string;
          status: Exclude<IntentState, "executed">;
          appId: string;
          action: string;
          reason?: string;
          attempts: number;
          enqueuedAt?: string;
          /** Conflict only: the two versions the overlay copy prints. */
          expectedVersion?: number;
          actualVersion?: number;
          /**
           * A dependent nothing is wrong with, held behind an earlier change
           * (R23). Computed HERE and not on the gateway, because the badge has
           * to be right in airplane mode, where no verdict exists and will not
           * for hours.
           */
          heldBadge?: string;
        }
      | NativeIntentAttention
    >
  > {
    const pending = await this.#coordinator.pendingIntents();
    const badges = new Map(
      chainHolds(pending).map((hold) => [hold.intentId, chainBadgeCopy(hold)])
    );
    const enqueuedTimes = this.#intentStore.enqueuedTimes();
    const retained = pending.flatMap((intent) => {
      const enqueuedAt = enqueuedTimes.get(intent.intentId);
      return intent.state === "executed"
        ? []
        : [
            {
              intentId: intent.intentId,
              // The intent's own state is the verdict (#922 G5); a conflict
              // is no longer re-derived from the presence of `conflict`.
              status: intent.state,
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
              ...(badges.has(intent.intentId)
                ? { heldBadge: badges.get(intent.intentId) }
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

  /**
   * The pending sheet's fourth verb, by the name the sheet uses. It is
   * `dismissAttention` under a word a member would recognise: what is being
   * dismissed is the remnant a settled write left behind, not the write.
   */
  dismissPendingChange(intentId: string): void {
    this.dismissAttention(intentId);
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
      void this.bootstrapWhenReachable().catch(() => undefined);
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

  /**
   * The pass the UI reads: did this pull LAND, and if not, was it the transfer
   * rules that stopped it?
   *
   * `pullNow` answers `false` for a blocked pull and a silent gateway alike,
   * and a caller that cannot tell them apart renders "Updated just now" over a
   * pull that never happened. The mount plane asked this question once for
   * four sessions; a seat asks it for its one.
   */
  async pullForeground(): Promise<{ landed: boolean; policyBlocked: boolean }> {
    if (!(await this.#isRowSyncAllowed()))
      return { landed: false, policyBlocked: true };
    // `pullNow`'s own boolean answers a NARROWER question — "did this pass
    // obtain anything" — and a pass that ran and found nothing new is a landed
    // pass, not a silent gateway. Only a throw is the other answer, and the
    // caller reads that as the pull not landing.
    await this.pullNow();
    return { landed: true, policyBlocked: false };
  }

  /** Force a foreground delta pull immediately (e.g. on manual refresh). */
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

  /**
   * The gateway's rebootstrap frame is recorded BEFORE the wipe-and-refetch
   * (#883 C6), so the member can be told why. No detail records nothing rather
   * than inventing a reason.
   */
  requireBootstrap(detail?: unknown): void {
    if (detail !== undefined)
      noteResyncVerdict(detail, this.#gatewayAuth.vaultId);
    this.#hasCursor = false;
    // Set BEFORE the refetch is scheduled, not inside it: the window this
    // closes is the one between deciding to replace the copy and starting to.
    this.#rebootstrapping = true;
    if (this.#closed) {
      // Nothing will run, so nothing may stay held: a closed session that left
      // the flag up would hand a reopened one a queue it never drains.
      this.#rebootstrapping = false;
      return;
    }
    void this.bootstrapWhenReachable()
      .catch(() => undefined)
      .finally(() => {
        this.#rebootstrapping = false;
        void this.flushIntents();
      });
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
    forgetPendingContentRefs();
    await this.#coordinator.close();
  }

  /** Membership revocation: close and delete this scope's rows and intents. */
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
    forgetPendingContentRefs();
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

  /** THE ONLY THING THAT ASKS AGAIN (#905): every other trigger fires once per
   *  event, so one refusal left an empty library over a full vault. Its own
   *  slot, never the outbox's — a parked drain must not swallow a rebootstrap. */
  private scheduleBootstrapRetry(): void {
    if (this.#bootstrapRetryTimer || this.#closed) return;
    this.#bootstrapRetryTimer = setTimeout(() => {
      this.#bootstrapRetryTimer = undefined;
      void this.bootstrapWhenReachable().catch(() => undefined);
    }, this.#bootstrapBackoff.next());
  }

  /**
   * `runWindowedBootstrap` owns the page walk, the page-1 cursor commit and the
   * mandatory convergence replay; a cursor is reported only once all succeed.
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
          // Page one IS the catalog, so a write admitted without one becomes
          // visible with the first rows rather than after the whole walk.
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
      // QUIESCE, WHICH IS NOT A STOP (R23, `SEAT_REBOOTSTRAP_CUTOVER` step 1).
      // While the copy is being replaced this claims nothing new — an answer
      // arriving mid-swap would be reconciled against a file that is about to
      // go — but an intent ALREADY SENDING keeps its answer, which is why the
      // check is here and not at the top of `flushIntents`. Cutting the whole
      // drain would strand a claimed intent in `sending` until the next
      // process open, and the member would be told nothing at all.
      if (this.#rebootstrapping) {
        this.settleWaitersAsQueued(admissionDuringRebootstrap().reason);
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

  /** Something changed, so do not keep waiting out an outage-length delay. */
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

  /** A durable admission is an honest settlement; an unresolved promise is not. */
  /**
   * Tell the byte store which content ids this queue still needs (R25).
   *
   * Pushed rather than pulled: the eviction sweep is synchronous and the
   * outbox is not, so the seat publishes on every move of the queue and the
   * sweep reads the last publication.
   */
  private async publishProtectedContent(): Promise<void> {
    try {
      publishPendingContentRefs(await this.#coordinator.pendingIntents());
    } catch {
      // A store that cannot be read protects nothing NEW; the previous answer
      // stands, which is the safe direction — it over-keeps, never over-evicts.
    }
  }

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
    requested?: string
  ): string {
    const candidates = this.#catalog.filter(
      (shape) =>
        shape.appId === appId &&
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

/** Store and intent outbox share ONE driver handle. */
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
    onRebootstrapRequired: (detail) => session?.requireBootstrap(detail),
    // The driver's own taxonomy, not the normalized-name default: it
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

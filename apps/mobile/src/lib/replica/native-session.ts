/*
 * THE PHONE'S SEAT SESSION (#996, W5).
 *
 * One vault, one file, and everything that vault's copy owns on this phone: the
 * seat, the queue of writes waiting to reach the gateway, and the invalidations
 * that tell a screen to re-read.
 *
 * WHAT THIS REPLACED. Until W5 this was a `ReplicaCoordinator` over a SHAPED
 * store — a projection of the vault into `replica_row` blobs, a declarative
 * read grammar, a windowed bootstrap that walked shapes page by page, and an
 * outbox in a second SQLite table beside it. All of it is gone. A seat holds
 * `vault.db` whole: a read is SQL, a bootstrap is a file copy, and the queue is
 * a table in the same file as the rows it is about (R24).
 *
 * THE SSE FEED IS A WAKE, NOT A DELIVERY. It used to carry the changes; a seat
 * pulls its own pages from the log door, so a frame means only "the gateway
 * moved" and the answer is one catch-up. Which is why there is no cursor here:
 * the seat's applied position is the only one anything resumes from.
 *
 * AND THE OUTBOX DOES NOT WAIT FOR THE COPY. A member's first write can happen
 * while the first bootstrap is still downloading — a phone opened on a train —
 * and an outbox that waited would put it in memory and lose it on relaunch. The
 * seat's FILE is opened before the session; `seat_outbox` is created with it,
 * empty or not.
 */

import {
  admissionDuringRebootstrap,
  AdmissionWaiters,
  drainIntents,
  InvalidationBus,
  isAuthorizationError,
  isSeatAuthorizationRevoked,
  postReplicaIntent,
  replicaIntentInvalidations,
  ReplicaProtocolError,
  seatPurgeInvalidation,
} from "@centraid/client/replica/native";
import type {
  GatewayAuth,
  IntentQueue,
  OptimisticMutation,
  ReplicaFetcher,
  ReplicaIdFactory,
  ReplicaIntent,
  ReplicaInvalidation,
  ReplicaSearchWireResult,
  ReplicaValue,
  SeatWatermark,
} from "@centraid/client/replica/native";
import { SeatSyncLoop } from "@centraid/client/replica/seat/seat-sync-loop";

import { backoffSchedule } from "../backoff";
import type { BackoffSchedule } from "../backoff";
import { SeatDelivery, seatDeliverySink } from "./delivery-triggers";
import { MobileIntentIds } from "./mobile-intent-id";
import {
  nativePendingChanges,
  nativePendingProjection,
  publishQueueContentRefs,
} from "./native-pending-changes";
import type { NativePendingChange } from "./native-pending-changes";
import type { NativeSeatPort } from "./native-seat";
import type {
  CreateNativeReplicaSessionOptions,
  MobileReplicaSession,
  NativeSearchRequest,
  NativeWriteInput,
  NativeWriteResult,
} from "./native-session-types";
import { NativeWriteRail } from "./native-write-rail";
import { forgetPendingContentRefs } from "./pending-content-refs";
import { isReplicaStorageFullError } from "./replica-storage-error";
import { noteResyncVerdict } from "./resync-notice";
import { SeatSyncErrorSink } from "./seat-sync-error";
import { stampVaultSourceRows } from "./vault-source";
import type { VaultSource } from "./vault-source";
import { waitingOnLabel } from "./waiting-on";

export type {
  AppStateLike,
  CreateNativeReplicaSessionOptions,
  MobileReplicaSession,
  NativeChangeFeed,
  NativeOptimisticMutation,
  NativeSearchRequest,
  NativeWriteInput,
  NativeWriteResult,
} from "./native-session-types";

/** Ceiling, not the usual wait: reconnect, foreground and writes all reset. */
const MAX_INTENT_RETRY_DELAY_MS = 5 * 60_000;

export class NativeReplicaSession implements MobileReplicaSession {
  readonly #gatewayAuth: GatewayAuth;
  /** #1014 C7: a later read of the mutable id could unprotect another vault. */
  readonly #vaultId: string;
  readonly #fetcher: ReplicaFetcher;
  readonly #delivery: SeatDelivery;
  readonly #seat: NativeSeatPort;
  readonly #syncLoop: SeatSyncLoop;
  readonly #queue: IntentQueue;
  readonly #bus = new InvalidationBus();
  readonly #admission: AdmissionWaiters<NativeWriteResult>;
  readonly #isConnected: () => boolean;
  readonly #retryBackoff: BackoffSchedule;
  readonly #isNetworkWorkAllowed: () => Promise<boolean>;
  readonly #isRowSyncAllowed: () => Promise<boolean>;
  readonly #intentIds: MobileIntentIds;
  readonly #waitingOnLabel: string | undefined;
  readonly #scope: VaultSource | undefined;
  readonly #onGatewayOutcome: ((reachable: boolean) => void) | undefined;
  /** Where this file got to, after the rows are durable (#1014, C3). */
  readonly #onApplied: ((applied: number) => void) | undefined;
  readonly #onStorageFull: ((error: unknown) => void) | undefined;
  readonly #onAuthorizationRevoked: (() => void) | undefined;
  readonly #writes: NativeWriteRail;
  /**
   * A re-bootstrap is being prepared or is running (#996 R23/R25).
   *
   * `admissionDuringRebootstrap` is the rule: a write is ADMITTED — refusing
   * would make "saved" untrue during a repair the member did not ask for and
   * cannot see — and it is NOT SENT, because the copy is about to be replaced.
   */
  #rebootstrapping = false;
  #storageFullError: unknown | undefined;
  /** The last catch-up failure, for Diagnostics and the status line (#1011). */
  readonly #syncErrors = new SeatSyncErrorSink();
  #drainPromise: Promise<void> | undefined;
  #drainRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    options: CreateNativeReplicaSessionOptions & {
      queue: IntentQueue;
      idFactory: ReplicaIdFactory;
    }
  ) {
    this.#gatewayAuth = options.gatewayAuth;
    if (!options.gatewayAuth.vaultId)
      throw new ReplicaProtocolError("An addressed vault is required");
    this.#vaultId = options.gatewayAuth.vaultId;
    this.#fetcher = options.fetcher;
    this.#delivery = new SeatDelivery({
      feed: options.changeFeed,
      appState: options.appState,
      onMessage: (message) => this.onFeedMessage(message),
      onForeground: () => {
        this.resetRetry();
        void this.catchUp();
        void this.flushIntents();
      },
      pull: () => {
        if (this.#closed || !this.#isConnected()) return;
        void this.pullNow();
      },
      ...(options.pullIntervalMs === undefined
        ? {}
        : { pullIntervalMs: options.pullIntervalMs }),
    });
    this.#seat = options.seat;
    this.#queue = options.queue;
    // KEPT, NOT DROPPED (#1011): the loop's one failure is the only thing that
    // explains an empty copy over a full vault, and it used to die inside
    // `SeatSyncLoop`.
    this.#syncLoop = new SeatSyncLoop(options.seat, {
      onError: (error) => this.#syncErrors.note(error),
    });
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
    this.#intentIds = new MobileIntentIds(options.idFactory);
    this.#onGatewayOutcome = options.onGatewayOutcome;
    this.#onApplied = options.onApplied;
    this.#onStorageFull = options.onStorageFull;
    this.#onAuthorizationRevoked = options.onAuthorizationRevoked;
    this.#waitingOnLabel = options.origin
      ? waitingOnLabel(options.origin.displayName)
      : undefined;
    this.#scope = options.scope;
    this.#admission = new AdmissionWaiters<NativeWriteResult>();
    this.#writes = new NativeWriteRail({
      gatewayAuth: this.#gatewayAuth,
      fetcher: this.#fetcher,
      seat: this.#seat,
      queue: this.#queue,
      bus: this.#bus,
      admission: this.#admission,
      intentIds: this.#intentIds,
      waitingOnLabel: this.#waitingOnLabel,
      isConnected: () => this.#isConnected(),
      flushIntents: () => void this.flushIntents(),
      publishProtectedContent: () => this.publishProtectedContent(),
    });
  }

  /** True while this scope's catch-up is parked for lack of device storage. */
  get storageFull(): boolean {
    return this.#storageFullError !== undefined;
  }

  /** Space was freed on the phone: unpark this scope's catch-up. */
  resumeAfterStorageFull(): void {
    if (this.#storageFullError === undefined) return;
    this.#storageFullError = undefined;
    void this.catchUp();
  }

  async start(): Promise<this> {
    this.#seat.attachSink(
      seatDeliverySink({
        emit: (invalidations) => this.#bus.emit(invalidations),
        ...(this.#onApplied ? { applied: this.#onApplied } : {}),
      })
    );
    await this.#queue.recoverSending();
    await this.publishProtectedContent();
    // THE COPY ARRIVES BEHIND THE MOUNT. Not awaited: the first bootstrap is
    // the whole vault file over whatever connection the phone has, and a member
    // who tapped an icon must not wait for it.
    void this.catchUp();
    this.#delivery.start();
    void this.flushIntents();
    return this;
  }

  /**
   * SEARCH RUNS ON THE SEAT (#996, ruling W5-D1) — the gateway's own statement
   * over the vault's FTS shadow tables in this phone's file.
   */
  async search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    this.assertOpen();
    void appId;
    const result = await this.#seat.search({
      entity: request.entity,
      query: request.query,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
    return this.#scope ? stampVaultSourceRows(result, this.#scope) : result;
  }

  write(appId: string, input: NativeWriteInput): Promise<NativeWriteResult> {
    this.assertOpen();
    return this.#writes.write(appId, input);
  }

  subscribe(
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    this.assertOpen();
    void appId;
    return this.#bus.subscribe(undefined, listener);
  }

  /** The one vault this session holds, or `undefined` for a test session. */
  scope(): VaultSource | undefined {
    return this.#scope;
  }

  /** How current this phone's copy is, or `undefined` before it has said. */
  watermark(): SeatWatermark | undefined {
    return this.#seat.watermark();
  }

  /** The overlay a restart rebuilds, in outbox order (R23). */
  pendingProjection(): Promise<OptimisticMutation[]> {
    return nativePendingProjection(this.#queue);
  }

  pendingChanges(): Promise<NativePendingChange[]> {
    return nativePendingChanges(this.#queue);
  }

  /** A member's own cancel retires the intent; only a gateway denial is retained. */
  cancelPendingChange(intentId: string): Promise<boolean> {
    return this.#writes.cancelPendingChange(intentId);
  }

  discardPendingWrite(intentId: string): Promise<boolean> {
    return this.#writes.discardPendingWrite(intentId);
  }

  revisePendingWrite(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<NativeWriteResult | undefined> {
    return this.#writes.revisePendingWrite(intentId, revision, expectedActions);
  }

  retryPendingWrite(intentId: string): Promise<NativeWriteResult | undefined> {
    return this.#writes.retryPendingWrite(intentId);
  }

  /**
   * The pending sheet's fourth verb, by the name the sheet uses. What is being
   * dismissed is the remnant a settled write left behind — and the remnant IS
   * the retained intent, so it is a discard (#996, W5).
   */
  dismissPendingChange(intentId: string): void {
    this.#writes.dismissPendingChange(intentId);
  }

  /** Wake the seat after the platform reports connectivity. */
  notifyReachable(): void {
    if (!this.#isConnected() || this.#closed) return;
    this.resetRetry();
    void this.catchUp();
    void this.flushIntents();
  }

  /** Replace an ephemeral loopback tunnel URL after process restart/reconnect. */
  updateGatewayBase(baseUrl: string): void {
    if (this.#closed || this.#gatewayAuth.baseUrl === baseUrl) return;
    this.#gatewayAuth.baseUrl = baseUrl;
    // THE SEAT MOVES WITH THE SESSION. It was opened before the tunnel existed
    // (its file carries the outbox, which cannot wait for the network), so the
    // base it holds is a placeholder or a previous launch's port. Rebasing the
    // feed alone left the snapshot and log doors pointed at a dead address and
    // the copy permanently empty.
    this.#seat.updateGatewayBase(baseUrl);
    this.#delivery.rebase();
  }

  async flushIntents(): Promise<void> {
    if (this.#closed || !this.#isConnected()) return;
    if (!(await this.#isNetworkWorkAllowed())) {
      // A paused drain must not hang an awaited write(); the intent is durable.
      this.queueEveryoneWaiting(
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
   * The pass the UI reads: did this catch-up LAND, and if not, was it the
   * transfer rules that stopped it?
   */
  async pullForeground(): Promise<{ landed: boolean; policyBlocked: boolean }> {
    if (!(await this.#isRowSyncAllowed()))
      return { landed: false, policyBlocked: true };
    return { landed: await this.pullNow(), policyBlocked: false };
  }

  /**
   * Catch this phone's copy up now (manual refresh, foreground, a wake frame),
   * and say whether it LANDED.
   *
   * A refused socket is not an exception here and never was — a seat that
   * could not reach the gateway is a seat with a slightly older copy — so the
   * answer is a boolean, not a throw. But it has to be an HONEST boolean: the
   * pull-to-refresh spinner and `pullForeground` both ask this question, and an
   * answer that is `true` whatever happened tells a member their library is
   * current when the network is gone.
   */
  /** Why the last catch-up did not land; `undefined` if it did (#1011). */
  get lastSyncError(): unknown | undefined {
    return this.#syncErrors.last;
  }

  async pullNow(): Promise<boolean> {
    if (this.#closed || this.storageFull) return false;
    if (!(await this.#isRowSyncAllowed())) return false;
    // The oracle is consulted by `catchUp` and ONLY there (#1011): checking it
    // here too let the foreground pass refuse without scheduling the retry
    // that is the only way back from a stale `false`.
    return this.catchUp();
  }

  /**
   * One catch-up, coalesced, with its one failure classified. `true` when the
   * seat came back level — `SeatSyncLoop` answers with the watermark it
   * reached, and `undefined` for the outage it swallowed.
   *
   * OUT OF ROOM PARKS IT rather than retrying (docs/mobile-offline.md), and so
   * does a drift no re-bootstrap resolves; nothing is wiped. Both were
   * unreachable until #1014 (C13/C14): `SeatSyncLoop` swallowed them.
   */
  private async catchUp(): Promise<boolean> {
    // NOT WHILE THE MOUNT BELIEVES IT IS OFFLINE (#905). `start()` fires this
    // one un-awaited, and a cold launch whose single reachability probe missed
    // mounts with `isConnected()` false while the socket underneath is fine.
    // Bootstrapping anyway would take a cursor the member never asked for and
    // make "this phone has no copy" untrue for the wrong reason; the wake that
    // corrects the probe calls back through here.
    if (this.#closed || this.storageFull) return false;
    // AND IT MUST ASK AGAIN (#1011). This guard used to return scheduling
    // nothing, while the oracle it consults was set from the PREVIOUS pull's
    // verdict — so one refused catch-up latched `isConnected()` false and the
    // phone never asked for a log page again, drawing an empty library over a
    // vault holding hundreds of rows. A retry is the only exit that does not
    // depend on the member noticing.
    if (!this.#isConnected()) {
      this.scheduleRetry();
      return false;
    }
    try {
      const landed = (await this.#syncLoop.sync()) !== undefined;
      if (landed) this.#syncErrors.clear();
      // A REFUSED CATCH-UP MUST BE ASKED AGAIN (#905). Every trigger that could
      // bootstrap this session fires once per EVENT — a reachability wake, a
      // foreground transition, a rebootstrap demand — and none of them is a
      // schedule. So when the first attempt after a wake is refused, nothing
      // asks a second time and the library draws its empty state over a vault
      // holding rows. `SeatSyncLoop` swallows the outage by design, which is
      // exactly why the verdict has to be acted on here.
      if (!landed) this.scheduleRetry();
      return landed;
    } catch (error) {
      if (isReplicaStorageFullError(error)) {
        this.#storageFullError = error;
        this.#onStorageFull?.(error);
      }
      // #1014 X7/X8: the phone used to answer a refusal by re-fetching the
      // vault from the gateway that had just revoked it, forever.
      if (isSeatAuthorizationRevoked(error)) this.#onAuthorizationRevoked?.();
      return false;
    }
  }

  /**
   * The gateway's rebootstrap frame is recorded BEFORE the copy is replaced
   * (#883 C6), so the member can be told why. A bootstrap is a FILE COPY now,
   * so the answer is one catch-up: `SeatLoop` re-bootstraps on a drift refusal
   * and carries the outbox and the pins across (R23).
   */
  requireBootstrap(detail?: unknown): void {
    if (detail !== undefined) noteResyncVerdict(detail, this.#vaultId);
    if (this.#closed) return;
    // Set BEFORE the refetch is scheduled: the window this closes is the one
    // between deciding to replace the copy and starting to.
    this.#rebootstrapping = true;
    this.#bus.emit(seatPurgeInvalidation());
    void this.catchUp().finally(() => {
      this.#rebootstrapping = false;
      this.#delivery.resumeFrom(this.#seat.watermark());
      void this.flushIntents();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detach();
    this.#admission.rejectAll(
      new ReplicaProtocolError("Replica session closed")
    );
    forgetPendingContentRefs(this.#vaultId);
    this.#queue.close();
    await this.#seat.close();
  }

  /** Stop the drain and wait for what is in flight, before the outbox is read
   *  for the revocation export (#1014, C25). */
  quiesce(): Promise<void> {
    this.detach();
    return (this.#drainPromise ?? Promise.resolve()).catch(() => undefined);
  }

  /** Everything this seat's queue still holds — the revocation export reads it. */
  listIntents(): Promise<ReplicaIntent[]> {
    return this.#queue.list();
  }

  /** Membership revocation: delete this scope's file and queue. `quiesce()`
   *  and the unsent export run FIRST, in `revoke-scope.ts` (R-1014-12). */
  async purge(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.detach();
    this.#admission.rejectAll(
      new ReplicaProtocolError("Replica scope was revoked")
    );
    this.#bus.emit(seatPurgeInvalidation());
    this.#bus.clear();
    forgetPendingContentRefs(this.#vaultId);
    await this.#seat.purge();
  }

  private detach(): void {
    // #1014 P17: its trailing follow-up fired after the file was unlinked.
    this.#syncLoop.close();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#delivery.stop();
  }

  /** A frame means the gateway moved; the seat's own cursor does the rest. */
  private onFeedMessage(message: { type: string; detail?: unknown }): void {
    if (this.#closed) return;
    if (message.type === "centraid:vault-rebootstrap") {
      this.requireBootstrap(message.detail);
      return;
    }
    void this.catchUp();
  }

  private drainLoop(): Promise<void> {
    return drainIntents({
      queue: this.#queue,
      send: (intent) =>
        postReplicaIntent(this.#gatewayAuth, intent, this.#fetcher),
      closed: () => this.#closed,
      online: () => this.#isConnected(),
      quiesced: () => {
        if (!this.#rebootstrapping) return false;
        this.queueEveryoneWaiting(admissionDuringRebootstrap().reason);
        return true;
      },
      settleRegistrations: () => this.#admission.settleRegistrations(),
      resolve: (intentId, result) => this.#admission.resolve(intentId, result),
      reject: (intentId, error) => this.#admission.reject(intentId, error),
      rejectAll: (error) => this.#admission.rejectAll(error),
      queueEveryoneWaiting: (reason) => this.queueEveryoneWaiting(reason),
      settled: (intent) => {
        this.#bus.emit(replicaIntentInvalidations([intent]));
        void this.publishProtectedContent();
      },
      appliedCommitSeq: () => this.#seat.watermark()?.appliedCommitSeq,
      isAuthorizationError,
      // #1014 X7: no requeue-and-re-bootstrap loop against a 403.
      onAuthorizationRevoked: () => this.#onAuthorizationRevoked?.(),
      scheduleRetry: () => this.scheduleRetry(),
      onGatewayOutcome: (reachable) => {
        if (reachable) this.#retryBackoff.reset();
        this.#onGatewayOutcome?.(reachable);
      },
    });
  }

  private queueEveryoneWaiting(reason: string): void {
    this.#admission.resolveAllAsQueued(reason, (intentId) => ({
      intentId,
      status: "queued" as const,
    }));
  }

  /**
   * One timer for both rails, on one backoff.
   *
   * The queue and the copy are refused by the same outage and recover on the
   * same reconnection, so two schedules would be two ways to spell the same
   * wait — and the one that was forgotten is the one that goes wrong (#905).
   */
  private scheduleRetry(): void {
    if (this.#retryTimer || this.#closed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.flushIntents();
      void this.catchUp();
    }, this.#retryBackoff.next());
  }

  /** Something changed, so do not keep waiting out an outage-length delay. */
  private resetRetry(): void {
    this.#retryBackoff.reset();
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  private publishProtectedContent(): Promise<void> {
    // Keyed by vault (#1014, C7): a module-global answer let one seat's queue
    // move make another mounted vault's captured photograph evictable.
    return publishQueueContentRefs(this.#vaultId, this.#queue);
  }

  private assertOpen(): void {
    if (this.#closed)
      throw new ReplicaProtocolError("Replica session is closed");
  }
}

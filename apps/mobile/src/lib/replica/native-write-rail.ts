/*
 * THE PHONE'S WRITE RAIL (#996, W5).
 *
 * Everything a member's write does between the tap and the outbox: the retained
 * intent it may revise instead, the projection that gives it ids, the base
 * versions it captures, the enqueue, and the four verbs the pending sheet
 * offers afterwards (cancel, discard, revise, retry).
 *
 * IT IS NOT THE DRAIN. Sending is the session's loop; this rail only ever puts
 * an intent into `seat_outbox` (or, for an online-only action, deliberately
 * nowhere) and says what the caller should be told meanwhile.
 */

import { projectPendingWrite } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";
import {
  admissionResult,
  authHeaders,
  prepareReplicaWrite,
  replicaIntentInvalidations,
  ReplicaProtocolError,
  VAULT_HEADER,
} from "@centraid/client/replica/native";
import type {
  AdmissionWaiters,
  EnqueueIntentInput,
  GatewayAuth,
  ReplicaBaseVersion,
  IntentQueue,
  InvalidationBus,
  ReplicaFetcher,
  ReplicaIntent,
  ReplicaValue,
} from "@centraid/client/replica/native";
import { appActionPath } from "@centraid/core/protocol";

import type { MobileIntentIds } from "./mobile-intent-id";
import type { NativeSeatPort } from "./native-seat";
import type {
  NativeWriteInput,
  NativeWriteResult,
} from "./native-session-types";

/** What the rail borrows from the session that owns it. */
export interface NativeWriteRailDeps {
  readonly gatewayAuth: GatewayAuth;
  readonly fetcher: ReplicaFetcher;
  readonly seat: NativeSeatPort;
  readonly queue: IntentQueue;
  readonly bus: InvalidationBus;
  readonly admission: AdmissionWaiters<NativeWriteResult>;
  readonly intentIds: MobileIntentIds;
  /** Who a queued write into this vault may wait for; absent in one's own. */
  readonly waitingOnLabel: string | undefined;
  readonly isConnected: () => boolean;
  /** The session's drain, asked for but never awaited by the rail. */
  readonly flushIntents: () => void;
  readonly publishProtectedContent: () => Promise<void>;
}

export class NativeWriteRail {
  readonly #gatewayAuth: GatewayAuth;
  readonly #fetcher: ReplicaFetcher;
  readonly #seat: NativeSeatPort;
  readonly #queue: IntentQueue;
  readonly #bus: InvalidationBus;
  readonly #admission: AdmissionWaiters<NativeWriteResult>;
  readonly #intentIds: MobileIntentIds;
  readonly #waitingOnLabel: string | undefined;
  readonly #isConnected: () => boolean;
  readonly #flushIntents: () => void;
  readonly #publishProtectedContent: () => Promise<void>;

  constructor(deps: NativeWriteRailDeps) {
    this.#gatewayAuth = deps.gatewayAuth;
    this.#fetcher = deps.fetcher;
    this.#seat = deps.seat;
    this.#queue = deps.queue;
    this.#bus = deps.bus;
    this.#admission = deps.admission;
    this.#intentIds = deps.intentIds;
    this.#waitingOnLabel = deps.waitingOnLabel;
    this.#isConnected = deps.isConnected;
    this.#flushIntents = deps.flushIntents;
    this.#publishProtectedContent = deps.publishProtectedContent;
  }

  async write(
    appId: string,
    input: NativeWriteInput
  ): Promise<NativeWriteResult> {
    if (!input.action)
      throw new ReplicaProtocolError("Replica action is required");
    // Before ANY projection, id minting or queue touch: an online-only write
    // has no representation in the outbox at all.
    if (input.onlineOnly === true) return this.#postAction(appId, input);
    // #922 G2: the row id no longer spells which intent minted it, so the
    // OUTBOX answers instead — exact, and it works for an id the origin has
    // already honoured too.
    const retained = await this.#queue.pendingIntentForInput(
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
    const { optimistic, dependencies } = prepareReplicaWrite(
      input.optimistic ?? projected.optimistic
    );
    const baseVersions =
      input.baseVersions ??
      projected.baseVersions ??
      (await this.#seat.baseVersions(optimistic));
    const matched = await this.#queue.reviseMatchingProjection(
      appId,
      input.action,
      minted,
      optimistic,
      baseVersions
    );
    if (matched) {
      this.#bus.emit(replicaIntentInvalidations([matched.replacement]));
      return this.#replacementAdmission(matched.replacement);
    }
    this.#admission.beginRegistration();
    try {
      const intent = await this.#queue.enqueue({
        intentId,
        appId,
        action: input.action,
        input: minted,
        optimistic,
        dependencies,
        ...(this.#waitingOnLabel ? { stewardLabel: this.#waitingOnLabel } : {}),
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      } satisfies EnqueueIntentInput);
      this.#bus.emit(replicaIntentInvalidations([intent]));
      // NOT AWAITED, and that is load-bearing: every await between the enqueue
      // and the waiter registration below is a window in which the drain can
      // settle this intent before anything is listening.
      void this.#publishProtectedContent();
      const settled = admissionResult(intent);
      if (settled) return settled;
      if (!this.#isConnected()) {
        // Awaited on THIS path only: no waiter is registered here, so there is
        // no race to widen, and an offline write is exactly the one whose bytes
        // must be protected before the caller can act on the answer.
        await this.#publishProtectedContent();
        return {
          intentId: intent.intentId,
          status: "queued",
          reason: "waiting for a connection",
        };
      }
      const admitted = this.#admission.await(intent.intentId);
      void this.#flushIntents();
      return admitted;
    } finally {
      this.#admission.finishRegistration();
    }
  }

  /**
   * The online-only transport: no durable trace of the payload on this device —
   * no intent id, no projection, no outbox row — and `executed` or throw, with
   * deliberately no `queued` branch.
   */
  async #postAction(
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
    return {
      intentId: `online-only:${appId}:${input.action}`,
      status: "executed",
      output,
    };
  }

  /** A member's own cancel retires the intent; only a gateway denial is retained. */
  async cancelPendingChange(intentId: string): Promise<boolean> {
    const pending = await this.#queue.pending();
    if (!pending.some((intent) => intent.intentId === intentId)) return false;
    const reason = "Cancelled on this device";
    await this.#queue.applyOutcomes([{ intentId, status: "denied", reason }]);
    await this.#queue.discard(intentId);
    this.#admission.resolve(intentId, { intentId, status: "denied", reason });
    return true;
  }

  async discardPendingWrite(intentId: string): Promise<boolean> {
    const existing = (await this.#queue.list()).find(
      (intent) => intent.intentId === intentId
    );
    const discarded = await this.#queue.discard(intentId);
    if (discarded && existing)
      this.#bus.emit(replicaIntentInvalidations([existing]));
    return discarded;
  }

  revisePendingWrite(
    intentId: string,
    revision: ReplicaValue,
    expectedActions?: readonly string[]
  ): Promise<NativeWriteResult | undefined> {
    return this.#replaceIntent(intentId, (refreshed) =>
      this.#queue.revise(intentId, revision, refreshed, expectedActions)
    );
  }

  retryPendingWrite(intentId: string): Promise<NativeWriteResult | undefined> {
    return this.#replaceIntent(intentId, (refreshed) =>
      this.#queue.retry(intentId, refreshed)
    );
  }

  /**
   * The pending sheet's fourth verb, by the name the sheet uses. What is being
   * dismissed is the remnant a settled write left behind — and the remnant IS
   * the retained intent, so it is a discard (#996, W5).
   */
  dismissPendingChange(intentId: string): void {
    void this.discardPendingWrite(intentId).catch(() => undefined);
  }

  /**
   * Revise or retry: one intent replaced by another, with FRESH base versions.
   *
   * Re-capturing is the point (#922 G5): a retry must observe the row that
   * rejected it, or it sends the same doomed precondition forever.
   */
  async #replaceIntent(
    intentId: string,
    replace: (
      refreshed: ReplicaBaseVersion[]
    ) => Promise<ReplicaIntent | undefined>
  ): Promise<NativeWriteResult | undefined> {
    const previous = (await this.#queue.list()).find(
      (intent) => intent.intentId === intentId
    );
    const replacement = await replace(
      previous ? await this.#seat.baseVersions(previous.optimistic) : []
    );
    if (!replacement) return undefined;
    if (previous) this.#bus.emit(replicaIntentInvalidations([previous]));
    this.#bus.emit(replicaIntentInvalidations([replacement]));
    return this.#replacementAdmission(replacement);
  }

  #replacementAdmission(replacement: ReplicaIntent): NativeWriteResult {
    if (!this.#isConnected())
      return {
        intentId: replacement.intentId,
        status: "queued",
        reason: "waiting for a connection",
      };
    void this.#flushIntents();
    return { intentId: replacement.intentId, status: "in-flight" };
  }
}

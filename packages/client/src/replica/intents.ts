import {
  pendingOverlayFacts,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlayFacts } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";

import { webCryptoDigest, webCryptoIdFactory } from "./digest.js";
import type { ReplicaDigest, ReplicaIdFactory } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { IntentRecordStore } from "./intent-record-store.js";
import {
  markSupersededIntent,
  namedRowIds,
  presentPendingIntentMutation,
  revisedInput,
  supersededIntentIds,
  withReplacementLock,
} from "./intent-revision.js";
import type {
  PendingIntentReplacement,
  PendingIntentRevisionTarget,
} from "./intent-revision.js";
import {
  applyInIntentOrder,
  applyIntentOutcomes,
  settleAnsweredIntents,
  settleIntentsAtCommitSeq,
} from "./intent-settlement.js";
import type { HeldVersionProbe } from "./intent-settlement.js";
import {
  OVERLAY_STATES,
  actionableAttention,
  retainedAttention,
} from "./intent-verdict.js";
import {
  chainBaseVersions,
  chainDependencies,
  mintedRowIndex,
  substitutePredecessorReferences,
  supersededByInput,
} from "./offline-chain.js";
import { mirrorOutbox } from "./outbox-mirror.js";
import type { OutboxMirror } from "./outbox-mirror.js";
import { intentPayloadHash } from "./payload-hash.js";
import type {
  EnqueueIntentInput,
  IntentOutcome,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaIntent,
  ReplicaValue,
} from "./types.js";

export interface IntentQueueOptions {
  idFactory?: ReplicaIdFactory;
  /** RN Hermes has no `crypto.subtle`; native hosts inject an expo-crypto digest. */
  digest?: ReplicaDigest;
  /** Retract a store's alert (native writes one) for a predecessor startup retires. */
  onSupersededRetired?: (intentId: string) => void;
  /**
   * Will something CALL `settleAtCommitSeq` for this queue (#996, R24)?
   *
   * It is a fact about the WIRING, not about the answer: every executed answer
   * has carried `commit_seq` since wave 1, so a queue that parks on it without
   * a cursor driver behind it holds `awaiting-change` forever — the pending
   * badge that never clears. Defaults to the store's own declaration, which
   * only the seat store makes; a host that drives the cursor over another
   * outbox says so here.
   */
  settlesByCommitSeq?: boolean;
}

export function presentPendingIntentFacts(
  intent: ReplicaIntent
): PendingOverlayFacts | undefined {
  return pendingOverlayFacts({
    intentId: intent.intentId,
    state: intent.state,
    action: intent.action,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.stewardLabel ? { stewardLabel: intent.stewardLabel } : {}),
    ...(intent.conflict ? { conflict: intent.conflict } : {}),
    ...(intent.attempts === undefined ? {} : { attempts: intent.attempts }),
    ...(intent.enqueuedAt ? { enqueuedAt: intent.enqueuedAt } : {}),
  });
}

/** What the member reads when a revoked share expires their queued write. */
export const SHAPE_REVOKED_REASON = "no longer shared with you";

/** An intent belongs to a shape if its optimistic rows or its declared read
 *  dependencies name it — the two places a shape id is written down. */
function touchesShape(intent: ReplicaIntent, shapeId: string): boolean {
  return (
    intent.optimistic.some((mutation) => mutation.shapeId === shapeId) ||
    (intent.dependencies ?? []).some(
      (dependency) => dependency.shapeId === shapeId
    ) ||
    (intent.baseVersions ?? []).some((version) => version.shapeId === shapeId)
  );
}

export class IntentQueue {
  readonly #idFactory: ReplicaIdFactory;
  readonly #digest: ReplicaDigest;
  readonly #onSupersededRetired: ((intentId: string) => void) | undefined;
  readonly #settlesByCommitSeq: boolean;
  readonly #mirror: OutboxMirror;
  /** The mirrored store: every write through it invalidates the overlay. */
  private readonly store: IntentRecordStore;

  constructor(store: IntentRecordStore, options: IntentQueueOptions = {}) {
    this.#mirror = mirrorOutbox(store);
    this.store = this.#mirror.store;
    this.#idFactory = options.idFactory ?? webCryptoIdFactory;
    this.#digest = options.digest ?? webCryptoDigest;
    this.#onSupersededRetired = options.onSupersededRetired;
    this.#settlesByCommitSeq =
      options.settlesByCommitSeq ?? store.settlesByCommitSeq === true;
  }

  /**
   * THE CHAIN IS DERIVED HERE, ONCE, BEFORE THE HASH (#996, R23).
   *
   * Three things happen in one place because they have to agree: the edges are
   * read off the outbox (never declared by an app, never inferred from a
   * value's shape), the row ids a predecessor's projection INVENTED become
   * `{"$intent": …}` references the gateway resolves from the durable outcome,
   * and the base set drops the rows those predecessors have not produced yet —
   * a version the seat never observed is not a precondition, and inventing one
   * is how a chain conflicts with itself on its own first run.
   *
   * The hash then covers the FINAL payload, `dependsOn` included, which is
   * what `expectedPayloadHash` verifies the id against.
   */
  async enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent> {
    const intentId = input.intentId ?? this.#idFactory();
    const minted = mintedRowIndex(
      await this.store.list(),
      new Set([intentId, ...supersededByInput(input)])
    );
    const dependsOn = chainDependencies(input.input, minted);
    const chained =
      dependsOn.length === 0
        ? input
        : {
            ...input,
            input: substitutePredecessorReferences(input.input, minted),
            ...(input.baseVersions
              ? { baseVersions: chainBaseVersions(input.baseVersions, minted) }
              : {}),
          };
    const payloadHash = await intentPayloadHash(
      { ...chained, dependsOn },
      this.#digest
    );
    return this.store.add({
      intentId,
      payloadHash,
      appId: chained.appId,
      action: chained.action,
      input: chained.input,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      state: "queued",
      attempts: 0,
      // One stamp for every rail; `add` returns the existing record, so a
      // replayed id keeps its first admission.
      enqueuedAt: new Date().toISOString(),
      optimistic: input.optimistic ?? [],
      dependencies: input.dependencies ?? [],
      ...(input.stewardLabel ? { stewardLabel: input.stewardLabel } : {}),
      ...(chained.baseVersions ? { baseVersions: chained.baseVersions } : {}),
    });
  }

  claimNext(): Promise<ReplicaIntent | undefined> {
    return this.store.claimNext();
  }

  transportFailed(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ["sending"], {
      state: "queued",
      reason,
    });
  }

  /**
   * Park a sent intent with no commit position to wait on (#1014, R1).
   *
   * `answeredVersions` is carried when the answer named them, because it is
   * the only other thing that can ever settle this record: `settleAnswered`
   * reads it off the row. Without either, the park is released by the next
   * send — the gateway's retained outcome is a dedupe hit.
   */
  awaitingChange(
    intentId: string,
    answeredVersions?: readonly ReplicaBaseVersion[]
  ): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ["sending"], {
      state: "awaiting-change",
      reason: undefined,
      ...(answeredVersions && answeredVersions.length > 0
        ? { answeredVersions: [...answeredVersions] }
        : {}),
    });
  }

  parked(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ["sending", "awaiting-change"], {
      state: "parked",
      reason,
    });
  }

  /**
   * The overlay every replica read composes over. It comes from the mirror,
   * so an empty outbox costs no IndexedDB work per read (#922 C1).
   */
  async pending(): Promise<ReplicaIntent[]> {
    return this.#mirror.pending([...OVERLAY_STATES]);
  }

  /** An answer, read against the queue. See `intent-settlement.ts`. */
  applyOutcomes(
    outcomes: IntentOutcome[],
    holdsVersion?: HeldVersionProbe
  ): Promise<ReplicaIntent[]> {
    return applyIntentOutcomes(
      this.store,
      outcomes,
      holdsVersion,
      this.#settlesByCommitSeq
    );
  }

  /**
   * Settle every answer this seat's applied cursor has now reached (#996,
   * R24). Called with the commit position the applier just committed.
   */
  settleAtCommitSeq(cursorCommitSeq: number): Promise<ReplicaIntent[]> {
    return settleIntentsAtCommitSeq(this.store, cursorCommitSeq);
  }

  /** The pre-#996 half of the same question, by row version (#929 G1). */
  settleAnswered(holdsVersion: HeldVersionProbe): Promise<ReplicaIntent[]> {
    return settleAnsweredIntents(this.store, holdsVersion);
  }

  /**
   * A SHARE WAS REVOKED (#929). The shape's rows leave this device, so every
   * write still queued over one of them can never land: it settles `expired`,
   * which is the outbox's own word for "this waited too long, decide again",
   * with the reason the member actually needs to read.
   *
   * `expired` is not `failed`: nothing went wrong on the wire, and there is no
   * retry that would work — the row is not this member's to write any more.
   */
  async expireShape(
    shapeId: string,
    reason = SHAPE_REVOKED_REASON
  ): Promise<ReplicaIntent[]> {
    const open = await this.store.list([...OVERLAY_STATES]);
    const expired: ReplicaIntent[] = [];
    await applyInIntentOrder(open, async (intent) => {
      if (!touchesShape(intent, shapeId)) return;
      if (intent.state === "expired") return;
      expired.push(
        await this.store.transition(intent.intentId, [intent.state], {
          state: "expired",
          reason,
        })
      );
    });
    return expired;
  }

  /** A renderer crash can strand claimed work; replay it with the same id and hash. */
  async recoverSending(
    reason = "recovered after reload"
  ): Promise<ReplicaIntent[]> {
    await this.settleSupersededAttention();
    const recovered: ReplicaIntent[] = [];
    await applyInIntentOrder(
      await this.store.list(["sending"]),
      async (intent) => {
        recovered.push(
          await this.store.transition(intent.intentId, ["sending"], {
            state: "queued",
            reason,
          })
        );
      }
    );
    return recovered;
  }

  async overlayMutations(
    shapeId?: string,
    entity?: string
  ): Promise<OptimisticMutation[]> {
    const intents = await this.pending();
    const result: OptimisticMutation[] = [];
    for (const intent of intents) {
      for (const mutation of intent.optimistic) {
        if (shapeId && mutation.shapeId !== shapeId) continue;
        if (entity && mutation.entity !== entity) continue;
        result.push(presentPendingIntentMutation(mutation, intent));
      }
    }
    return result;
  }

  async overlay(
    shapeId?: string,
    entity?: string
  ): Promise<{
    mutations: OptimisticMutation[];
    sidecar: Readonly<Record<string, PendingOverlayFacts>>;
  }> {
    const intents = await this.pending();
    const mutations: OptimisticMutation[] = [];
    const sidecar: Record<string, PendingOverlayFacts> = {};
    for (const intent of intents) {
      let projected = false;
      for (const mutation of intent.optimistic) {
        if (shapeId && mutation.shapeId !== shapeId) continue;
        if (entity && mutation.entity !== entity) continue;
        mutations.push(presentPendingIntentMutation(mutation, intent));
        projected = true;
      }
      const facts = projected ? presentPendingIntentFacts(intent) : undefined;
      if (facts) sidecar[intent.intentId] = facts;
    }
    return { mutations, sidecar };
  }

  list(): Promise<ReplicaIntent[]> {
    return this.store.list();
  }

  listSettled(limit?: number): Promise<IntentOutcome[]> {
    return this.store.listSettled(limit);
  }

  async discard(intentId: string): Promise<boolean> {
    const existing = await this.store.get(intentId);
    if (!retainedAttention(existing)) return false;
    // Discard removes a projection; it never rewrites the durable result as a
    // successful execution. A Commons expired/cancelled row is locally parked,
    // so parked is deliberately accepted here while the generic UI still does
    // not offer discard until its online enrichment reports terminal status.
    await this.settleRetained(existing);
    return true;
  }

  async retry(
    intentId: string,
    refreshedBaseVersions?: ReplicaBaseVersion[]
  ): Promise<ReplicaIntent | undefined> {
    return withReplacementLock(intentId, async () => {
      const successor = await this.successorFor(intentId);
      if (successor) {
        const superseded = await this.store.get(intentId);
        if (actionableAttention(superseded))
          await this.settleRetained(superseded);
        return successor;
      }
      const existing = await this.store.get(intentId);
      if (!actionableAttention(existing)) return undefined;
      return this.replace(existing, existing.input, refreshedBaseVersions);
    });
  }

  /** Revise a terminal optimistic write as a new immutable transport intent. */
  async revise(
    intentId: string,
    revision: ReplicaValue,
    refreshedBaseVersions?: ReplicaBaseVersion[],
    expectedActions?: readonly string[]
  ): Promise<ReplicaIntent | undefined> {
    return withReplacementLock(intentId, async () => {
      const successor = await this.successorFor(intentId);
      if (successor) {
        if (expectedActions && !expectedActions.includes(successor.action))
          return undefined;
        const superseded = await this.store.get(intentId);
        if (actionableAttention(superseded))
          await this.settleRetained(superseded);
        return successor;
      }
      const existing = await this.store.get(intentId);
      if (!actionableAttention(existing)) return undefined;
      if (expectedActions && !expectedActions.includes(existing.action))
        return undefined;
      const input = revisedInput(
        existing.input,
        revision,
        new Set(existing.optimistic.map((mutation) => mutation.rowId))
      );
      return this.replace(existing, input, refreshedBaseVersions);
    });
  }

  /**
   * The queued intent whose projection minted a row id this write NAMES
   * (#922 G2).
   *
   * It replaces the `pending:` grammar, which encoded the intent id in the
   * row id so a caller could read it back out. Ids are canonical now, so the
   * OUTBOX is asked instead — exact, and it does not care what the id looks
   * like. Only declared revisions match: an app says which action revises
   * which in `revisions`, and nothing is guessed from an arbitrary `*_id`.
   */
  async pendingIntentForInput(
    appId: string,
    action: string,
    input: ReplicaValue
  ): Promise<PendingIntentRevisionTarget | undefined> {
    const expectedActions = pendingProjectionFor(appId)?.revisions?.[action];
    if (!expectedActions || expectedActions.length === 0) return undefined;
    const named = new Set(namedRowIds(input));
    if (named.size === 0) return undefined;
    const match = (await this.store.list()).findLast(
      (intent) =>
        intent.appId === appId &&
        OVERLAY_STATES.has(intent.state) &&
        expectedActions.includes(intent.action) &&
        intent.optimistic.some((mutation) => named.has(mutation.rowId))
    );
    return match ? { intentId: match.intentId, expectedActions } : undefined;
  }

  /**
   * A terminal edit of a canonical row has no synthetic id in its domain
   * input. Match it against the exact projected row identity instead; this
   * keeps primary/foreign-key knowledge in the projection declaration and
   * never guesses from arbitrary `*_id` fields.
   */
  async reviseMatchingProjection(
    appId: string,
    action: string,
    revision: ReplicaValue,
    optimistic: readonly OptimisticMutation[],
    refreshedBaseVersions?: ReplicaBaseVersion[]
  ): Promise<PendingIntentReplacement | undefined> {
    const identities = new Set(
      optimistic.map(
        (mutation) =>
          `${mutation.shapeId}\u0000${mutation.entity}\u0000${mutation.rowId}`
      )
    );
    if (identities.size === 0) return undefined;
    const candidates = (await this.store.list()).filter(
      (intent) =>
        actionableAttention(intent) &&
        intent.appId === appId &&
        intent.action === action &&
        intent.optimistic.some((mutation) =>
          identities.has(
            `${mutation.shapeId}\u0000${mutation.entity}\u0000${mutation.rowId}`
          )
        )
    );
    const existing = candidates.at(-1);
    if (!existing) return undefined;
    const replacement = await this.revise(
      existing.intentId,
      revision,
      refreshedBaseVersions,
      [action]
    );
    return replacement
      ? { replacement, supersededIntentId: existing.intentId }
      : undefined;
  }

  private async replace(
    existing: ReplicaIntent,
    input: ReplicaValue,
    refreshedBaseVersions?: ReplicaBaseVersion[]
  ): Promise<ReplicaIntent> {
    const replacementIntentId = this.#idFactory();
    if (replacementIntentId === existing.intentId) {
      throw new ReplicaProtocolError(
        "A pending-write replacement requires a fresh intent id"
      );
    }
    const projectionInput =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Readonly<Record<string, unknown>>)
        : {};
    const projected = projectPendingWrite(
      pendingProjectionFor(existing.appId),
      {
        appId: existing.appId,
        action: existing.action,
        input: projectionInput,
        intentId: replacementIntentId,
      }
    );
    const optimistic = projected.optimistic.flatMap((mutation) => {
      const shapeId =
        mutation.shapeId ??
        existing.optimistic.find(
          (candidate) => candidate.entity === mutation.entity
        )?.shapeId;
      return shapeId ? [{ ...mutation, shapeId } as OptimisticMutation] : [];
    });
    const baseVersions = refreshedBaseVersions ?? projected.baseVersions ?? [];
    const replacementInput: EnqueueIntentInput = {
      intentId: replacementIntentId,
      appId: existing.appId,
      action: existing.action,
      input,
      optimistic: markSupersededIntent(
        optimistic.length > 0 ? optimistic : existing.optimistic,
        existing.intentId
      ),
      dependencies: existing.dependencies,
      baseVersions,
    };
    // Add-first keeps a visible local fact across a crash; the marker lets
    // startup finish the predecessor's settlement.
    const replacement = await this.enqueue(replacementInput);
    await this.settleRetained(existing);
    return replacement;
  }

  private settleRetained(existing: ReplicaIntent): Promise<ReplicaIntent> {
    return this.store.settle(existing.intentId, [existing.state], {
      state: existing.state,
      reason: existing.reason,
      output: existing.output,
      conflict: existing.conflict,
    });
  }

  private async successorFor(
    intentId: string
  ): Promise<ReplicaIntent | undefined> {
    return (await this.store.list()).find((intent) =>
      supersededIntentIds(intent).includes(intentId)
    );
  }

  private async settleSupersededAttention(): Promise<void> {
    const intents = await this.store.list();
    const byId = new Map(intents.map((intent) => [intent.intentId, intent]));
    await applyInIntentOrder(intents, async (replacement) => {
      await applyInIntentOrder(
        supersededIntentIds(replacement),
        async (supersededId) => {
          const superseded = byId.get(supersededId);
          if (!actionableAttention(superseded)) return;
          await this.settleRetained(superseded);
          this.#onSupersededRetired?.(supersededId);
          byId.delete(supersededId);
        }
      );
    });
  }

  close(): void {
    this.store.close();
  }

  purge(): Promise<void> {
    return this.store.destroy();
  }
}

// The revision algebra moved to `intent-revision.ts` when this file passed the
// source cap; the queue is still where callers reach it.
export {
  presentPendingIntentMutation,
  type PendingIntentReplacement,
  type PendingIntentRevisionTarget,
} from "./intent-revision.js";

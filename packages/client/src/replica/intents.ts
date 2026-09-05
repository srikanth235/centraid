import {
  decoratePendingMutation,
  pendingOverlayFacts,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type {
  PendingIntentPresentationInput,
  PendingOverlayFacts,
  PendingOverlaySidecar,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";

import { webCryptoDigest, webCryptoIdFactory } from "./digest.js";
import type { ReplicaDigest, ReplicaIdFactory } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { IntentRecordStore } from "./intent-record-store.js";
import {
  PENDING_SUPERSEDES_FIELD,
  cloneReplicaValue,
  markSupersededIntent,
  namedRowIds,
  revisedInput,
  supersededIntentIds,
  withReplacementLock,
} from "./intent-revision.js";
import type {
  PendingIntentReplacement,
  PendingIntentRevisionTarget,
} from "./intent-revision.js";
import {
  OVERLAY_STATES,
  actionableAttention,
  intentVerdict,
  retainedAttention,
} from "./intent-verdict.js";
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

/** The overlay a read applies: projected rows, and the facts behind them. */
export interface ReplicaOverlay {
  mutations: OptimisticMutation[];
  sidecar: PendingOverlaySidecar;
}

/**
 * Intent transitions share one durable queue; preserve outcome order instead
 * of racing state reads and writes for the same optimistic overlay.
 */
function applyInIntentOrder<T>(
  values: Iterable<T>,
  apply: (value: T) => void | PromiseLike<void>
): Promise<void> {
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value)),
    Promise.resolve()
  );
}

export interface IntentQueueOptions {
  idFactory?: ReplicaIdFactory;
  /** RN Hermes has no `crypto.subtle`; native hosts inject an expo-crypto digest. */
  digest?: ReplicaDigest;
  /** Retract a store's alert (native writes one) for a predecessor startup retires. */
  onSupersededRetired?: (intentId: string) => void;
}

/**
 * Convert a durable intent mutation into the schema-safe visible mutation.
 * Browser and native reads must share this boundary: the recovery marker is
 * engine-private, and a wire conflict is presented from its structured detail
 * even though the persisted state remains the existing `failed` value.
 */
export function presentPendingIntentMutation(
  mutation: OptimisticMutation,
  intent: ReplicaIntent
): OptimisticMutation {
  const visible: OptimisticMutation =
    mutation.op === "upsert"
      ? {
          ...mutation,
          values: Object.fromEntries(
            Object.entries(mutation.values).flatMap(([key, value]) =>
              key === PENDING_SUPERSEDES_FIELD
                ? []
                : [[key, cloneReplicaValue(value)]]
            )
          ),
        }
      : { ...mutation };
  return decoratePendingMutation(
    visible,
    pendingPresentation(intent)
  ) as OptimisticMutation;
}

/** The presented facts of one intent, for the row's key and for the sidecar. */
function pendingPresentation(
  intent: ReplicaIntent
): PendingIntentPresentationInput {
  return {
    intentId: intent.intentId,
    state: intent.state,
    action: intent.action,
    attempts: intent.attempts,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.conflict ? { conflict: intent.conflict } : {}),
    ...(intent.enqueuedAt ? { enqueuedAt: intent.enqueuedAt } : {}),
    ...(intent.stewardLabel ? { stewardLabel: intent.stewardLabel } : {}),
  };
}

/** What one intent tells a read's sidecar, or nothing once it has executed. */
export function presentPendingIntentFacts(
  intent: ReplicaIntent
): PendingOverlayFacts | undefined {
  return pendingOverlayFacts(pendingPresentation(intent));
}

export class IntentQueue {
  readonly #idFactory: ReplicaIdFactory;
  readonly #digest: ReplicaDigest;
  readonly #onSupersededRetired: ((intentId: string) => void) | undefined;
  readonly #mirror: OutboxMirror;
  /** The mirrored store: every write through it invalidates the overlay. */
  private readonly store: IntentRecordStore;

  constructor(store: IntentRecordStore, options: IntentQueueOptions = {}) {
    this.#mirror = mirrorOutbox(store);
    this.store = this.#mirror.store;
    this.#idFactory = options.idFactory ?? webCryptoIdFactory;
    this.#digest = options.digest ?? webCryptoDigest;
    this.#onSupersededRetired = options.onSupersededRetired;
  }

  async enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent> {
    const intentId = input.intentId ?? this.#idFactory();
    const payloadHash = await intentPayloadHash(input, this.#digest);
    return this.store.add({
      intentId,
      payloadHash,
      appId: input.appId,
      action: input.action,
      input: input.input,
      state: "queued",
      attempts: 0,
      // One stamp for every rail; `add` returns the existing record, so a
      // replayed id keeps its first admission.
      enqueuedAt: new Date().toISOString(),
      optimistic: input.optimistic ?? [],
      dependencies: input.dependencies ?? [],
      ...(input.baseVersions ? { baseVersions: input.baseVersions } : {}),
      ...(input.stewardLabel ? { stewardLabel: input.stewardLabel } : {}),
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

  awaitingChange(intentId: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ["sending"], {
      state: "awaiting-change",
      reason: undefined,
    });
  }

  parked(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ["sending", "awaiting-change"], {
      state: "parked",
      reason,
    });
  }

  async applyOutcomes(outcomes: IntentOutcome[]): Promise<ReplicaIntent[]> {
    const updated: ReplicaIntent[] = [];
    await applyInIntentOrder(outcomes, async (outcome) => {
      const existing = await this.store.get(outcome.intentId);
      if (!existing || !OVERLAY_STATES.has(existing.state)) return;
      // A conflict is a state of its own, and a conflict whose BASE ROW IS
      // GONE is a third one (#922 G5): the member's remedy differs, so the
      // verdict must too. The outbox `state` column is unconstrained TEXT, so
      // widening the vocabulary needs no migration on either store.
      const verdict = intentVerdict(outcome);
      const patch = {
        ...verdict,
        reason: outcome.reason,
        output: outcome.output,
        ...(outcome.conflict ? { conflict: outcome.conflict } : {}),
      };
      // Executed is the only settled state: the unchanged outbox contract
      // journals it and scrubs its input. Attention outcomes remain ordinary
      // outbox transitions, so their existing optimistic projection survives
      // restart without changing any store schema or implementation.
      updated.push(
        outcome.status === "executed"
          ? await this.store.settle(
              outcome.intentId,
              [...OVERLAY_STATES],
              patch
            )
          : await this.store.transition(
              outcome.intentId,
              [...OVERLAY_STATES],
              patch
            )
      );
    });
    return updated;
  }

  /**
   * The overlay every replica read composes over. It comes from the mirror,
   * so an empty outbox costs no IndexedDB work per read (#922 C1).
   */
  async pending(): Promise<ReplicaIntent[]> {
    return this.#mirror.pending([...OVERLAY_STATES]);
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

  /**
   * The overlay one read must apply: the mutations, and the sidecar that says
   * what is happening to each write behind them. Built together because a row
   * carrying an intent whose facts are missing is a badge with nothing behind
   * it (#922 G3).
   */
  async overlay(shapeId?: string, entity?: string): Promise<ReplicaOverlay> {
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
      if (!projected) continue;
      const facts = presentPendingIntentFacts(intent);
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

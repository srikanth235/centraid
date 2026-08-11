import {
  decoratePendingMutation,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingProjectionDeclaration } from "@centraid/blueprints/apps/_shared/pending-overlay";

import { webCryptoDigest, webCryptoIdFactory } from "./digest.js";
import type { ReplicaDigest, ReplicaIdFactory } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { IntentRecordStore } from "./intent-record-store.js";
import { intentPayloadHash } from "./payload-hash.js";
import type {
  EnqueueIntentInput,
  IntentOutcome,
  IntentState,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaIntent,
  ReplicaValue,
} from "./types.js";

const OVERLAY_STATES = new Set<IntentState>([
  "queued",
  "sending",
  "awaiting-change",
  "parked",
  "denied",
  "failed",
]);
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
}

const SYNTHETIC_PENDING_ROW = /^pending:(?<intentId>[^:]+):/u;
const PENDING_SUPERSEDES_FIELD = "__centraid_pending_supersedes";
const REVISION_IDENTITY_PROBE = "__centraid_revision_identity_probe__";
/**
 * Replica values are JSON-shaped, but React Native 0.81/Hermes does not expose
 * the browser `structuredClone` global. Keep cloning inside the shared value
 * grammar so browser and native replacement paths have the same runtime.
 */
function cloneReplicaValue(value: ReplicaValue): ReplicaValue {
  if (Array.isArray(value)) return value.map(cloneReplicaValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        cloneReplicaValue(child),
      ])
    );
  }
  return value;
}

export interface PendingIntentRevisionTarget {
  intentId: string;
  expectedActions: readonly string[];
}

export interface PendingIntentReplacement {
  replacement: ReplicaIntent;
  supersededIntentId: string;
}

/** Keep all eight app projection modules out of the cold shell boot chunk. */
async function pendingProjectionForApp(
  appId: string
): Promise<PendingProjectionDeclaration | undefined> {
  const { pendingProjectionFor } =
    await import("@centraid/blueprints/apps/_shared/pending-projections");
  return pendingProjectionFor(appId);
}

/** Resolve only an explicitly declared edit of a projected synthetic row. */
export async function pendingIntentIdFromInput(
  appId: string,
  action: string,
  input: ReplicaValue
): Promise<PendingIntentRevisionTarget | undefined> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const declaration = await pendingProjectionForApp(appId);
  const expectedActions = declaration?.revisions?.[action];
  if (!declaration || !expectedActions || expectedActions.length === 0)
    return undefined;
  const projected = projectPendingWrite(declaration, {
    appId,
    action,
    input: input as Readonly<Record<string, unknown>>,
    intentId: REVISION_IDENTITY_PROBE,
  });
  for (const mutation of projected.optimistic) {
    const match = SYNTHETIC_PENDING_ROW.exec(mutation.rowId);
    const intentId = match?.groups?.intentId;
    if (intentId && intentId !== REVISION_IDENTITY_PROBE)
      return { intentId, expectedActions };
  }
  return undefined;
}

function retainedAttention(
  intent: ReplicaIntent | undefined
): intent is ReplicaIntent {
  return (
    intent?.state === "denied" ||
    intent?.state === "failed" ||
    intent?.state === "parked"
  );
}

function actionableAttention(
  intent: ReplicaIntent | undefined
): intent is ReplicaIntent {
  return intent?.state === "denied" || intent?.state === "failed";
}

function supersededIntentIds(intent: ReplicaIntent): string[] {
  return [
    ...new Set(
      intent.optimistic.flatMap((mutation) => {
        if (mutation.op !== "upsert") return [];
        const value = mutation.values[PENDING_SUPERSEDES_FIELD];
        return typeof value === "string" ? [value] : [];
      })
    ),
  ];
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
  return decoratePendingMutation(visible, {
    intentId: intent.intentId,
    state: intent.conflict ? "conflict" : intent.state,
    action: intent.action,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.conflict ? { conflict: intent.conflict } : {}),
  }) as OptimisticMutation;
}

export class IntentQueue {
  readonly #idFactory: ReplicaIdFactory;
  readonly #digest: ReplicaDigest;

  constructor(
    private readonly store: IntentRecordStore,
    options: IntentQueueOptions = {}
  ) {
    this.#idFactory = options.idFactory ?? webCryptoIdFactory;
    this.#digest = options.digest ?? webCryptoDigest;
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
      optimistic: input.optimistic ?? [],
      dependencies: input.dependencies ?? [],
      ...(input.baseVersions ? { baseVersions: input.baseVersions } : {}),
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
      // Conflict is a wire outcome, not a persisted outbox state. Preserve its
      // structured detail on the existing `failed` state so the schema and the
      // gateway's outcome vocabulary remain unchanged.
      const state: IntentState =
        outcome.status === "conflict" ? "failed" : outcome.status;
      const patch = {
        state,
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

  async pending(): Promise<ReplicaIntent[]> {
    return this.store.list([...OVERLAY_STATES]);
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
    const { withReplacementLock } = await import("./intent-replacement.js");
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
    const { revisedPendingInput, withReplacementLock } =
      await import("./intent-replacement.js");
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
      const input = revisedPendingInput(existing.input, revision, intentId);
      return this.replace(existing, input, refreshedBaseVersions);
    });
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
    const [{ replacementInput }, declaration] = await Promise.all([
      import("./intent-replacement.js"),
      pendingProjectionForApp(existing.appId),
    ]);
    // Add-first keeps a visible local fact across a crash. The private marker
    // lets startup finish the truthful old-outcome settlement if interruption
    // lands between these two unchanged store primitives.
    const replacement = await this.enqueue(
      replacementInput(
        existing,
        input,
        replacementIntentId,
        refreshedBaseVersions,
        declaration
      )
    );
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

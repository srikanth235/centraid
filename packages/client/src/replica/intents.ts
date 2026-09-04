import {
  decoratePendingMutation,
  projectPendingWrite,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import { pendingProjectionFor } from "@centraid/blueprints/apps/_shared/pending-projections";

import { webCryptoDigest, webCryptoIdFactory } from "./digest.js";
import type { ReplicaDigest, ReplicaIdFactory } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { IntentRecordStore } from "./intent-record-store.js";
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
 * "Does this replica already hold origin version V of that row?" Only the seat
 * can answer; a seat that cannot is treated as holding nothing, so an answer
 * without a probe waits rather than clearing early.
 */
export type HeldVersionProbe = (version: ReplicaBaseVersion) => boolean;

function heldEverywhere(
  answered: readonly ReplicaBaseVersion[],
  holdsVersion: HeldVersionProbe | undefined
): boolean {
  if (!holdsVersion) return false;
  return answered.every((version) => holdsVersion(version));
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

const SYNTHETIC_PENDING_ROW = /^pending:(?<intentId>[^:]+):/u;
const PENDING_SUPERSEDES_FIELD = "__centraid_pending_supersedes";
const replacementLocks = new Map<string, Promise<void>>();

interface WebLockManager {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
}

/**
 * Replacement is a read/add/settle transaction over an intentionally unchanged
 * store contract. Serialize it per intent in this realm, and use the browser's
 * Web Locks boundary when several PWA tabs share the same IndexedDB outbox.
 * The durable successor marker is still the recovery truth after a crash.
 */
async function withReplacementLock<T>(
  intentId: string,
  task: () => Promise<T>
): Promise<T> {
  const local = async (): Promise<T> => {
    const prior = replacementLocks.get(intentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    replacementLocks.set(intentId, current);
    await prior.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (replacementLocks.get(intentId) === current)
        replacementLocks.delete(intentId);
    }
  };
  const locks = (
    globalThis as unknown as { navigator?: { locks?: WebLockManager } }
  ).navigator?.locks;
  return locks
    ? locks.request(`centraid:replica-intent:${intentId}`, local)
    : local();
}

function isRowIdentityField(key: string): boolean {
  return key === "id" || key === "__rowId" || key.endsWith("_id");
}

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

/** Every row id a write's identity fields name. */
function namedRowIds(input: ReplicaValue): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, ReplicaValue>)
    .filter(
      ([key, value]) => isRowIdentityField(key) && typeof value === "string"
    )
    .map(([, value]) => value as string);
}

function revisedInput(
  existing: ReplicaValue,
  revision: ReplicaValue,
  mintedRowIds: ReadonlySet<string>
): ReplicaValue {
  if (
    !existing ||
    typeof existing !== "object" ||
    Array.isArray(existing) ||
    !revision ||
    typeof revision !== "object" ||
    Array.isArray(revision)
  )
    return revision;
  const merged = cloneReplicaValue(existing) as Record<string, ReplicaValue>;
  for (const [key, value] of Object.entries(revision)) {
    // The revision names the row this intent already minted; the identity is
    // not the thing being revised, so it never overwrites itself (#922 G2 —
    // the id no longer spells which intent made it, so the intent's own
    // projected rows are the answer).
    if (
      isRowIdentityField(key) &&
      typeof value === "string" &&
      mintedRowIds.has(value)
    )
      continue;
    if (key.startsWith("clear_") && value === true) {
      const field =
        (
          {
            due: "due_at",
            project: "project_id",
            remind: "remind_before_min",
            rrule: "rrule",
            section: "section_id",
          } as const
        )[key.slice("clear_".length)] ?? key.slice("clear_".length);
      delete merged[field];
      continue;
    }
    merged[key] = cloneReplicaValue(value);
  }
  return merged;
}

function markSupersededIntent(
  mutations: readonly OptimisticMutation[],
  intentId: string
): OptimisticMutation[] {
  return mutations.map((mutation) =>
    mutation.op === "upsert"
      ? {
          ...mutation,
          values: {
            ...mutation.values,
            [PENDING_SUPERSEDES_FIELD]: intentId,
          },
        }
      : mutation
  );
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
    state: intent.state,
    action: intent.action,
    attempts: intent.attempts,
    ...(intent.reason ? { reason: intent.reason } : {}),
    ...(intent.conflict ? { conflict: intent.conflict } : {}),
    ...(intent.enqueuedAt ? { enqueuedAt: intent.enqueuedAt } : {}),
  }) as OptimisticMutation;
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

  /**
   * G1 (#929): an `executed` answer that names ORIGIN ROW VERSIONS settles the
   * pending row only once this replica HOLDS them. Until then the intent stays
   * `awaiting-change` — the state the outbox already has for "the gateway said
   * yes, the row has not arrived" — so the badge clears when the member can
   * actually see their own change, not one round trip earlier.
   *
   * `holdsVersion` is injected because only the seat can answer it: on an
   * audience it reads the subscription's shape lineage, and a seat that cannot
   * answer passes nothing and settles as before.
   */
  async applyOutcomes(
    outcomes: IntentOutcome[],
    holdsVersion?: HeldVersionProbe
  ): Promise<ReplicaIntent[]> {
    const updated: ReplicaIntent[] = [];
    await applyInIntentOrder(outcomes, async (outcome) => {
      const existing = await this.store.get(outcome.intentId);
      if (!existing || !OVERLAY_STATES.has(existing.state)) return;
      if (
        outcome.status === "executed" &&
        outcome.answeredVersions &&
        outcome.answeredVersions.length > 0 &&
        !heldEverywhere(outcome.answeredVersions, holdsVersion)
      ) {
        updated.push(
          await this.store.transition(outcome.intentId, [...OVERLAY_STATES], {
            state: "awaiting-change",
            answeredVersions: outcome.answeredVersions,
            reason: undefined,
          })
        );
        return;
      }
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
        ...(outcome.waitingOn ? { waitingOn: outcome.waitingOn } : {}),
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

  /**
   * Settle the answers this replica has now caught up to (G1). Called after a
   * change batch applies: an `awaiting-change` intent whose answered versions
   * have arrived is executed, and the outbox journals it as it always did.
   */
  async settleAnswered(
    holdsVersion: HeldVersionProbe
  ): Promise<ReplicaIntent[]> {
    const waiting = await this.store.list(["awaiting-change"]);
    const settled: ReplicaIntent[] = [];
    await applyInIntentOrder(waiting, async (intent) => {
      const answered = intent.answeredVersions ?? [];
      if (answered.length === 0) return;
      if (!heldEverywhere(answered, holdsVersion)) return;
      settled.push(
        await this.store.settle(intent.intentId, ["awaiting-change"], {
          state: "executed",
        })
      );
    });
    return settled;
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

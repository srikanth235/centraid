/**
 * REVISING A PENDING INTENT (#922 G2).
 *
 * A member who edits a write that has not left the device yet is revising an
 * intent, not making a second one. That transaction — take the lock, merge the
 * revision over the input, mark the successor, retire the predecessor — is the
 * whole of this module, and the durable successor marker it writes is the
 * recovery truth after a crash. The marker is engine-private: it rides the
 * stored mutation and never reaches a row a screen reads.
 */
import type {
  OptimisticMutation,
  ReplicaIntent,
  ReplicaValue,
} from "./types.js";

export const PENDING_SUPERSEDES_FIELD = "__centraid_pending_supersedes";
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
export async function withReplacementLock<T>(
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
export function cloneReplicaValue(value: ReplicaValue): ReplicaValue {
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
export function namedRowIds(input: ReplicaValue): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, ReplicaValue>)
    .filter(
      ([key, value]) => isRowIdentityField(key) && typeof value === "string"
    )
    .map(([, value]) => value as string);
}

export function revisedInput(
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

export function markSupersededIntent(
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

export function supersededIntentIds(intent: ReplicaIntent): string[] {
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

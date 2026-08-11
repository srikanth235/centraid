import {
  projectPendingWrite,
  type PendingProjectionDeclaration,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

import type {
  EnqueueIntentInput,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaIntent,
  ReplicaValue,
} from "./types.js";

const PENDING_SUPERSEDES_FIELD = "__centraid_pending_supersedes";
const replacementLocks = new Map<string, Promise<void>>();

interface WebLockManager {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
}

/** Serialize immutable replacement across calls in this realm and across PWA tabs. */
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

export function revisedPendingInput(
  existing: ReplicaValue,
  revision: ReplicaValue,
  intentId: string
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
    if (
      isRowIdentityField(key) &&
      typeof value === "string" &&
      value.startsWith(`pending:${intentId}:`)
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

export function replacementInput(
  existing: ReplicaIntent,
  input: ReplicaValue,
  replacementIntentId: string,
  refreshedBaseVersions?: ReplicaBaseVersion[],
  declaration?: PendingProjectionDeclaration
): EnqueueIntentInput {
  const projectionInput =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Readonly<Record<string, unknown>>)
      : {};
  const projected = projectPendingWrite(declaration, {
    appId: existing.appId,
    action: existing.action,
    input: projectionInput,
    intentId: replacementIntentId,
  });
  const optimistic = projected.optimistic.flatMap((mutation) => {
    const shapeId =
      mutation.shapeId ??
      existing.optimistic.find(
        (candidate) => candidate.entity === mutation.entity
      )?.shapeId;
    return shapeId ? [{ ...mutation, shapeId } as OptimisticMutation] : [];
  });
  return {
    intentId: replacementIntentId,
    appId: existing.appId,
    action: existing.action,
    input,
    optimistic: markSupersededIntent(
      optimistic.length > 0 ? optimistic : existing.optimistic,
      existing.intentId
    ),
    dependencies: existing.dependencies,
    baseVersions: refreshedBaseVersions ?? projected.baseVersions ?? [],
  };
}

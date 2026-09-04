/*
 * The overlay the outbox holds RIGHT NOW, in memory (#922 C1).
 *
 * Every replica read composes replica ⊕ outbox, so every read used to open an
 * IndexedDB transaction and run one indexed `getAll` per overlay state — nine
 * round trips to learn that nothing is queued, which is the overwhelmingly
 * common case. The mirror answers from memory instead: an EMPTY outbox costs
 * no IndexedDB work at all, and a non-empty one costs one lookup.
 *
 * IT IS SOUND BECAUSE THE OUTBOX HAS ONE WRITER. The browser replica opens
 * OPFS through `opfs-sahpool`, which takes an exclusive lock on its files, so a
 * second tab cannot run a coordinator over the same outbox — it falls back to
 * an in-memory store of its own. On React Native there is one process. If that
 * ever stops being true, this mirror is the thing that breaks, so the reason
 * is written here rather than left to be re-derived.
 *
 * Reads are mirrored; EVERYTHING ELSE INVALIDATES. A method added to the store
 * later invalidates by default, because forgetting to invalidate serves a
 * stale overlay and forgetting to mirror only costs a query.
 */

import type { IntentRecordStore } from "./intent-record-store.js";
import type { IntentState, ReplicaIntent } from "./types.js";

/** Methods that cannot change what the outbox holds. */
const PURE_READS = new Set<keyof IntentRecordStore>([
  "get",
  "list",
  "listSettled",
]);

export interface OutboxMirror {
  /** The store to use in place of the one handed in. */
  readonly store: IntentRecordStore;
  /** The overlay states' intents, from memory when the mirror is warm. */
  pending: (states: readonly IntentState[]) => Promise<ReplicaIntent[]>;
}

export function mirrorOutbox(store: IntentRecordStore): OutboxMirror {
  let mirrored: ReplicaIntent[] | undefined;
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (PURE_READS.has(property as keyof IntentRecordStore)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]): unknown => {
        mirrored = undefined;
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: wrapped,
    pending: async (states) => {
      mirrored ??= await store.list(states);
      return mirrored;
    },
  };
}

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
 *
 * AND ONE WRITER IS NOT THE SAME AS ONE PATH THROUGH THE PROXY (#1014, C11).
 * Where the outbox shares the seat's file, R24's `clearSeatOverlaysAtCommit`
 * runs `DELETE FROM seat_outbox` inside the APPLIER's transaction — the same
 * process, the same connection, and not through this proxy. Nothing here saw
 * it, so the mirror went on serving settled intents as pending forever: a
 * badge on a row that had already landed, until something else happened to
 * write. `invalidateOutboxMirror` is what the shell calls when it is told the
 * overlays cleared, keyed by the store the mirror was built over.
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
  /** Forget everything held. What a write outside the proxy has to call. */
  readonly invalidate: () => void;
}

/**
 * Every live mirror, by the store it was built over.
 *
 * A WeakMap rather than a field on the proxy: the caller that learns the
 * overlays cleared (the shell session) holds the RAW store it handed to the
 * queue, not the queue's wrapped one, and the mirror belongs to neither of
 * them to own.
 */
const MIRRORS = new WeakMap<IntentRecordStore, () => void>();

/** Drop whatever a mirror over this store is holding. Safe on an unmirrored one. */
export function invalidateOutboxMirror(
  store: IntentRecordStore | undefined
): void {
  if (store) MIRRORS.get(store)?.();
}

export function mirrorOutbox(store: IntentRecordStore): OutboxMirror {
  // KEYED BY THE STATES ASKED FOR (#1014, C11). One cache for every argument
  // served the first caller's answer to the second: `pending(["queued"])`
  // after `pending(OVERLAY_STATES)` got the wider list, and the narrower one
  // poisoned the wider. The states are a handful of short strings, so the key
  // is just them.
  const mirrored = new Map<string, ReplicaIntent[]>();
  const invalidate = (): void => mirrored.clear();
  MIRRORS.set(store, invalidate);
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (PURE_READS.has(property as keyof IntentRecordStore)) {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return (...args: unknown[]): unknown => {
        invalidate();
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: wrapped,
    invalidate,
    pending: async (states) => {
      const key = [...states].join("\u0000");
      const held = mirrored.get(key);
      if (held) return held;
      const fresh = await store.list(states);
      mirrored.set(key, fresh);
      return fresh;
    },
  };
}

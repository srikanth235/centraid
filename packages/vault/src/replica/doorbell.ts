import type { DatabaseSync } from 'node:sqlite';

type ReplicaDoorbellListener = () => void;

const listeners = new WeakMap<DatabaseSync, Set<ReplicaDoorbellListener>>();

/** Wake replica streams after a canonical vault transaction commits. */
export function notifyReplicaCommit(db: DatabaseSync): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener();
    } catch {
      // A disconnected stream cannot interfere with command finalization.
    }
  }
}

export function subscribeReplicaCommits(
  db: DatabaseSync,
  listener: ReplicaDoorbellListener,
): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(db);
  };
}

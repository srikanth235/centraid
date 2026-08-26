// Optimistic-mutation contract (#659): write the intent locally, commit on
// the wire, reconcile via `settle` only after success. A rejection rolls the
// pre-edit value back exactly (rollback, never a refetch) and rethrows —
// deliberately not swallowed; the caller owns how failure reads.

export interface OptimisticUpdate<T> {
  read: () => T;
  write: (next: T) => void;
  apply: (previous: T) => T;
  /** The wire call. A rejection rolls the local edit back. */
  commit: () => Promise<unknown>;
  /** Optional post-success reconciliation (usually a refetch). */
  settle?: () => Promise<void>;
}

export async function optimisticUpdate<T>(
  update: OptimisticUpdate<T>
): Promise<void> {
  const before = update.read();
  update.write(update.apply(before));
  try {
    await update.commit();
  } catch (error) {
    update.write(before);
    throw error;
  }
  if (update.settle) await update.settle();
}

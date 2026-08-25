// The optimistic-mutation contract (#659).
//
// Every list mutation in the shell was written the same way: await the wire
// call, then refetch the whole list, then re-render. Renaming a conversation
// therefore took a round trip before the name changed, and pinning a run
// destroyed and rebuilt the list. The gesture is the user's statement of
// intent; the wire call is confirmation, not permission.
//
// So: write the intent locally, send it, and reconcile. If the commit rejects,
// the pre-edit value goes back exactly — a rollback, not a refetch, so a
// failure cannot be confused with "the server also changed something".
// Reconciliation (`settle`) runs only after a success, and only to replace the
// guess with the server's version.

export interface OptimisticUpdate<T> {
  /** Read the current value (called once, before the edit). */
  read: () => T;
  /** Write a value back to wherever `read` reads from. */
  write: (next: T) => void;
  /** The local edit — pure, given the pre-edit value. */
  apply: (previous: T) => T;
  /** The wire call. A rejection rolls the local edit back. */
  commit: () => Promise<unknown>;
  /** Optional post-success reconciliation (usually a refetch). */
  settle?: () => Promise<void>;
}

/**
 * Apply `apply` immediately, run `commit`, and either reconcile via `settle`
 * or restore the pre-edit value and rethrow. The rejection is deliberately not
 * swallowed: the caller owns how a failure reads to the user.
 */
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

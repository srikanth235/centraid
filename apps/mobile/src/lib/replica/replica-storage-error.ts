const STORAGE_FULL_MESSAGE =
  "Phone storage is full. Centraid paused replica sync without deleting local data or pending changes. Free space, clear the thumbnail cache if needed, then try again.";

// Split for the `out of room` state component (Binding Layer brief, "States"
// — cause, consequence, one action; the consequence line is the one that
// matters). Kept as separate exports rather than parsed out of
// STORAGE_FULL_MESSAGE so the UI copy can diverge from the Error's own
// message without the two drifting silently.
/** The CAUSE, stated plainly. */
export const STORAGE_FULL_CAUSE = "Phone storage is full.";
/** The CONSEQUENCE — the line that outranks the cause on screen. */
export const STORAGE_FULL_CONSEQUENCE =
  "Replica sync is paused — nothing was deleted, but new changes won't sync until there's room.";
/** The ONE action offered alongside cause + consequence. */
export const STORAGE_FULL_ACTION_LABEL = "Free up thumbnail cache";

/** Actionable, stable device-storage failure surfaced by replica screens. */
export class ReplicaStorageFullError extends Error {
  override readonly name = "ReplicaStorageFullError";

  constructor(options?: { cause?: unknown }) {
    super(STORAGE_FULL_MESSAGE, options);
  }
}

/** op-sqlite varies by platform: match its code, SQLite errcode, and message. */
export function isReplicaStorageFullError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errcode?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "SQLITE_FULL" ||
    candidate.code === "ENOSPC" ||
    candidate.errcode === 13 ||
    (typeof candidate.message === "string" &&
      /(?:database or disk is full|SQLITE_FULL|ENOSPC|no space left)/iu.test(
        candidate.message
      ))
  );
}

/** Preserve unrelated errors; normalize SQLite/OS disk-full variants. */
export function asReplicaStorageError(error: unknown): Error {
  if (error instanceof ReplicaStorageFullError) return error;
  if (isReplicaStorageFullError(error))
    return new ReplicaStorageFullError({ cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

const STORAGE_FULL_MESSAGE =
  "Phone storage is full — replica sync is paused until you free space.";

export const STORAGE_FULL_CAUSE = "Phone storage is full.";
export const STORAGE_FULL_CONSEQUENCE =
  "Replica sync is paused — new changes won't sync until there's room.";
export const STORAGE_FULL_ACTION_LABEL = "Free up thumbnail cache";

export class ReplicaStorageFullError extends Error {
  override readonly name = "ReplicaStorageFullError";

  constructor(options?: { cause?: unknown }) {
    super(STORAGE_FULL_MESSAGE, options);
  }
}

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

export function asReplicaStorageError(error: unknown): Error {
  if (error instanceof ReplicaStorageFullError) return error;
  if (isReplicaStorageFullError(error))
    return new ReplicaStorageFullError({ cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/* oxlint-disable max-classes-per-file -- domain error and disk-full classifier are one error surface (#408) */
// Disk-full classification (#351): nothing upstream can tell SQLITE_FULL from
// a schema bug without inspecting `code`/`errcode`. Every write path shares
// this check, so ENOSPC and SQLITE_FULL fail closed the same way.

export function isDiskFullError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown };
  if (e.code === "ENOSPC") return true;
  // node:sqlite puts the raw result code on `errcode`; SQLITE_FULL is 13.
  if (e.code === "ERR_SQLITE_ERROR" && e.errcode === 13) return true;
  if (typeof e.errstr === "string" && /disk.*full|SQLITE_FULL/iu.test(e.errstr))
    return true;
  return false;
}

export class VaultDiskFullError extends Error {
  constructor(
    readonly context: string,
    message: string
  ) {
    super(message);
    this.name = "VaultDiskFullError";
  }
}

/**
 * Anything not disk-full passes through unchanged, so a real bug still looks
 * like one. Reports into `sharedDiskFullTracker` — the ONE funnel every write
 * path passes — so no catch site up the stack must.
 */
export function asVaultDiskFullError(context: string, err: unknown): Error {
  if (isDiskFullError(err)) {
    const detail = err instanceof Error ? err.message : String(err);
    sharedDiskFullTracker.report(err, context);
    return new VaultDiskFullError(
      context,
      `disk full during ${context}: ${detail}`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * BACKPRESSURE, never loss (#405): the spool is at budget with nothing safely
 * evictable, so routes map it to a retryable 429, not `VaultDiskFullError`'s
 * 507. The invariant it PROTECTS: no ingest deletes an un-replicated blob.
 */
export class VaultBlobBackpressureError extends Error {
  readonly code = "blob_capacity_exceeded";

  constructor(
    readonly context: string,
    message: string,
    readonly details?: {
      needBytes: number;
      availableBytes: number;
      freeBytes: number | null;
      reservedHeadroomBytes: number;
      outboxBudgetBytes?: number;
      expectedShaRequired?: boolean;
    }
  ) {
    super(message);
    this.name = "VaultBlobBackpressureError";
  }
}

export class VaultBlobHashMismatchError extends Error {
  readonly code = "blob_hash_mismatch";

  constructor(
    readonly expectedSha256: string,
    readonly actualSha256: string
  ) {
    super(
      `blob SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`
    );
    this.name = "VaultBlobHashMismatchError";
  }
}

export class VaultBlobSessionError extends Error {
  readonly code = "blob_session_conflict";

  constructor(
    message: string,
    readonly expectedOffset?: number
  ) {
    super(message);
    this.name = "VaultBlobSessionError";
  }
}

export class VaultBlobAuthorizationError extends Error {
  readonly code = "blob_device_forbidden";

  constructor(message: string) {
    super(message);
    this.name = "VaultBlobAuthorizationError";
  }
}

export class VaultBlobRemoteUnavailableError extends Error {
  readonly code = "blob_remote_unavailable";

  constructor(message = "remote blob provider is unavailable") {
    super(message);
    this.name = "VaultBlobRemoteUnavailableError";
  }
}

/** Raised BEFORE the audience vault is written: a refusal beats a half-placed item. */
export class VaultShareError extends Error {
  readonly code = "share_placement_failed";

  constructor(message: string) {
    super(message);
    this.name = "VaultShareError";
  }
}

export interface DiskFullEvent {
  at: string;
  context: string;
  message: string;
}

/**
 * A `statfs` reading fine again does not make the last failed write safe to
 * forget: the probe stays red until `clear()` confirms recovery.
 */
export class DiskFullTracker {
  private last: DiskFullEvent | null = null;

  report(err: unknown, context: string): void {
    if (!isDiskFullError(err)) return;
    this.last = {
      at: new Date().toISOString(),
      context,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  current(): DiskFullEvent | null {
    return this.last;
  }

  /** Call once free space is CONFIRMED recovered. */
  clear(): void {
    this.last = null;
  }
}

/** One process, one disk: a test needing isolation constructs its own. */
export const sharedDiskFullTracker = new DiskFullTracker();

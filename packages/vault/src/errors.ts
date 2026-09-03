/* oxlint-disable max-classes-per-file -- domain error and disk-full classifier are one error surface (#408) */

export function isDiskFullError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown };
  if (e.code === "ENOSPC") return true;
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

  clear(): void {
    this.last = null;
  }
}

export const sharedDiskFullTracker = new DiskFullTracker();

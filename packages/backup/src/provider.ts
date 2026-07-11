/*
 * The `centraid-backup-provider/1` seam (PROTOCOL.md): everything a client
 * (the engine in this package) needs from an offsite backup provider, and
 * nothing about how the provider is implemented. Field names below are
 * copied verbatim from PROTOCOL.md's JSON examples — this file IS the wire
 * contract in TypeScript, so drift between prose and types is a bug in one
 * of them.
 */

/** `GET /v1/backup/provider` response — everything a client adapts to. */
export type Retention =
  | {
      kind: 'ladder';
      /** Keep every snapshot this recent. */
      keepAllDays: number;
      /** Then newest-per-day. */
      dailyDays: number;
      /** Then newest-per-week; older pruned. */
      weeklyDays: number;
      /** MUST be `true` (PROTOCOL.md) — the newest snapshot is never pruned. */
      neverPruneNewest: true;
    }
  | { kind: 'none' };

export interface ProviderCapabilities {
  protocol: string[];
  dataPlane: 's3';
  maxCredentialTtlSeconds: number;
  softDeleteWindowDays: number;
  retention: Retention;
  restoreCostClass: 'free-egress' | 'metered-egress';
  /** Provider can make objects immutable. */
  objectLock: boolean;
  /** Data plane honors If-None-Match. */
  conditionalWrites: boolean;
  purgeAuthTier: 'api-key' | 'interactive';
}

/** `accountStatus` on the target list — surfaced so backups don't stop silently. */
export type AccountStatus = 'ok' | 'payment_due' | 'suspended';

export interface Usage {
  storedBytes: number;
  objectCount: number;
  /** Optional — a provider may not cap storage. */
  quotaBytes?: number;
  /** Unix epoch seconds. Optional — a provider may not meter. */
  meteredAt?: number;
}

/** One row of `GET /v1/backup/vaults` — a target ("vault" on the wire). */
export interface TargetInfo {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  usage: Usage;
}

/** Short-lived, prefix-scoped S3 credentials for the data plane. */
export interface S3Grant {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: number;
  mode: 'read' | 'read-write';
}

/** One registry row — the response of registration, and of listSnapshots/getSnapshot. */
export interface SnapshotRow {
  seq: number;
  manifestKey: string;
  manifestHash: string;
  prevManifestHash: string | null;
  totalBytes: number;
  objectCount: number;
  generation: number;
  format: string;
  appMeta: Record<string, string>;
  /** Unix epoch seconds — all wire timestamps are epoch-second integers (PROTOCOL.md). */
  createdAt: number;
  /** Unix epoch seconds, or null while the row is live. */
  prunedAt: number | null;
}

/** `POST /v1/backup/vaults/:id/snapshots` request body. */
export interface SnapshotRegistration {
  /** Provider MUST replay the prior result on retry. */
  idempotencyKey: string;
  /** MUST fall under the target's prefix. */
  manifestKey: string;
  manifestHash: string;
  totalBytes: number;
  objectCount: number;
  /** Fencing token, >= 1. */
  generation: number;
  format: string;
  appMeta: Record<string, string>;
}

/** Reserved error codes (PROTOCOL.md § Error envelope) — providers MAY add others. */
export type BackupProviderErrorCode =
  | 'invalid_request'
  | 'auth_expired'
  | 'payment_required'
  | 'interactive_auth_required'
  | 'quota_exceeded'
  | 'not_found'
  | 'undelete_window_expired'
  | 'conflict_generation'
  | 'purge_pending'
  | 'provider_error';

/** The HTTP status the reserved codes map to (PROTOCOL.md's table, column 2). */
export const CODE_STATUS: Readonly<Record<BackupProviderErrorCode, number>> = {
  invalid_request: 400,
  auth_expired: 401,
  payment_required: 402,
  interactive_auth_required: 403,
  quota_exceeded: 403,
  not_found: 404,
  undelete_window_expired: 404,
  conflict_generation: 409,
  purge_pending: 409,
  provider_error: 502,
};

export interface BackupProviderErrorDetails {
  currentGeneration?: number;
  [key: string]: unknown;
}

/** Every provider-surfaced failure — local and remote providers throw the same shape. */
export class BackupProviderError extends Error {
  readonly status: number;
  readonly code: BackupProviderErrorCode | string;
  readonly details: BackupProviderErrorDetails | undefined;

  constructor(opts: {
    status: number;
    code: BackupProviderErrorCode | string;
    message: string;
    details?: BackupProviderErrorDetails;
  }) {
    super(opts.message);
    this.name = 'BackupProviderError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  /** Convenience constructor for a reserved code — status comes from `CODE_STATUS`. */
  static of(
    code: BackupProviderErrorCode,
    message: string,
    details?: BackupProviderErrorDetails,
  ): BackupProviderError {
    return new BackupProviderError({ status: CODE_STATUS[code], code, message, details });
  }
}

/**
 * The provider seam (PROTOCOL.md § Routes). One implementation per provider;
 * `local-provider.ts` and `remote-provider.ts` both implement this, and
 * `conformance.ts` grades any third implementation against the same cases.
 */
export interface BackupProvider {
  capabilities(): Promise<ProviderCapabilities>;

  createTarget(opts: { label: string }): Promise<{ targetId: string }>;
  deleteTarget(targetId: string): Promise<void>;
  undeleteTarget(targetId: string): Promise<void>;
  /** Local provider supports it (api-key tier); remote MUST throw `interactive_auth_required`. */
  purgeTarget(targetId: string): Promise<void>;

  openDataPlane(
    targetId: string,
    mode: 'read' | 'read-write',
  ): Promise<import('./object-store.js').ObjectStore>;

  registerSnapshot(targetId: string, reg: SnapshotRegistration): Promise<SnapshotRow>;
  listSnapshots(targetId: string, opts?: { includePruned?: boolean }): Promise<SnapshotRow[]>;
  getSnapshot(targetId: string, seq: number): Promise<SnapshotRow>;

  /** Includes `currentGeneration` and `usage`. */
  getTarget(targetId: string): Promise<TargetInfo>;
  usage(targetId: string): Promise<{ usage: Usage; accountStatus: AccountStatus }>;
}

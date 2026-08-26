import type * as TypeImport_6gxkc6 from "./object-store.js";
/*
 * The `centraid-storage-provider/1` wire contract in TypeScript. Field names are
 * verbatim from PROTOCOL.md's JSON, so drift between prose and types is a bug in
 * one of them. Grouped as PROTOCOL.md layers it: Layer 1 is account + grants,
 * generic across store classes; Layer 2 is per-store-class workload semantics.
 */

// ─── Layer 1 — Account & grants ─────

/** Store classes this revision defines (PROTOCOL.md § Terminology). */
export type StoreClass = "backup" | "cas" | "derived";

/** Runtime enumeration of `StoreClass`; guards must read it, not relist. Order is stable. */
export const STORE_CLASSES = [
  "backup",
  "cas",
  "derived",
] as const satisfies readonly StoreClass[];

/** Additive: a provider declares only the surfaces it actually offers. */
export type ProviderCapabilityFlag =
  | StoreClass
  | "usage"
  | "policy"
  | "inventory"
  | "audit";

/** Advisory bundles (PROTOCOL.md § Profiles). Capability FLAGS, not profiles,
 *  are the protocol-evolution seam. */
export type ProviderProfile = "home";

/** Runtime enumeration; conformance's profile checks read it. */
export const PROVIDER_PROFILES = [
  "home",
] as const satisfies readonly ProviderProfile[];

/** What a `home`-profile provider MUST declare. `policy` is required so the
 *  client's freshness contract has a declared cadence to anchor against. */
export const HOME_PROFILE_CAPABILITIES = [
  "backup",
  "cas",
  "derived",
  "usage",
  "policy",
  "inventory",
  "audit",
] as const satisfies readonly ProviderCapabilityFlag[];

export type Retention =
  | {
      kind: "ladder";
      /** Keep every snapshot this recent. */
      keepAllDays: number;
      /** Then newest-per-day. */
      dailyDays: number;
      /** Then newest-per-week; older pruned. */
      weeklyDays: number;
      /** MUST be `true`: the newest snapshot is never pruned. */
      neverPruneNewest: true;
    }
  | { kind: "none" };

/** Discovery's backup-store fields; present iff `capabilities` has `"backup"`. */
export interface BackupDiscovery {
  softDeleteWindowDays: number;
  retention: Retention;
  restoreCostClass: "free-egress" | "metered-egress";
  objectLock: boolean;
  /** Data plane honors If-None-Match. */
  conditionalWrites: boolean;
}

/** `GET /v1/storage/provider` response. */
export interface ProviderCapabilities {
  protocol: string[];
  dataPlane: "s3";
  capabilities: ProviderCapabilityFlag[];
  /** A declared `home` profile MUST carry all `HOME_PROFILE_CAPABILITIES`;
   *  absent is still conformant. */
  profiles?: ProviderProfile[];
  maxCredentialTtlSeconds: number;
  purgeAuthTier: "api-key" | "interactive";
  /** Present iff `capabilities` includes `"backup"`. */
  backup?: BackupDiscovery;
  /** `x-amz-storage-class` values the data plane accepts. Absent ⇒ clients MUST
   *  NOT send the header; declared ⇒ the data plane MUST accept those values. */
  storageClasses?: string[];
}

/** Surfaced on the target list so backups don't stop silently. */
export type AccountStatus = "ok" | "payment_due" | "suspended";

/** Backup store's per-target usage, embedded in the target list. */
export interface Usage {
  storedBytes: number;
  objectCount: number;
  /** Absent when a provider does not cap storage. */
  quotaBytes?: number;
  /** Unix epoch seconds; absent when a provider does not meter. */
  meteredAt?: number;
}

/** One row of `GET /v1/storage/vaults`. */
export interface TargetInfo {
  id: string;
  name: string;
  status: "active" | "deleted";
  currentGeneration: number;
  usage: Usage;
}

/** Short-lived data-plane credentials. One isolated prefix per store class:
 *  `u/{id}/backup/`, `u/{id}/cas/`. */
export interface S3Grant {
  endpoint: string;
  /** The data plane's real SigV4 region, never a client-side hardcode.
   *  `"auto"` is valid (R2). */
  region: string;
  bucket: string;
  prefix: string;
  store: StoreClass;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: number;
  mode: "read" | "read-write";
}

/** Per-store-class report. Distinct from `Usage`, the backup store's own
 *  target-list figure. */
export interface StoreUsageReport {
  bytesStored: number;
  objectCount: number;
  /** Provider-defined operation counters, e.g. `{"put": 12}`. */
  opCounts?: Record<string, number>;
  /** `null` = unmetered (no cap). */
  quotaBytes: number | null;
  /** Unix epoch seconds. */
  period: { start: number; end: number };
}

export type UsageByStore = Partial<Record<StoreClass, StoreUsageReport>>;

/** Client-declared cadence and CAS acknowledgement contract. */
export interface ProviderPolicyDeclaration {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: "receipt" | "replicated";
}

/** Provider echo; `declaredAt` is provider-stamped epoch seconds. */
export interface ProviderPolicy extends ProviderPolicyDeclaration {
  declaredAt: number;
}

export interface ProviderInventoryQuery {
  store: StoreClass;
  cursor?: string;
  /** Inclusive unix epoch-second lower bound on `storedAt`. */
  since?: number;
  limit?: number;
}

export interface ProviderInventoryObject {
  key: string;
  sizeBytes: number;
  etagOrHash: string;
  storedAt: number;
  storageClass?: string;
  state: "live" | "soft-deleted";
}

export interface ProviderInventoryPage {
  store: StoreClass;
  objects: ProviderInventoryObject[];
  nextCursor: string | null;
}

export type ProviderEventKind =
  | "prune"
  | "soft-delete"
  | "undelete"
  | "purge"
  | "credential-issued"
  | "policy-changed";

/** Append-only; rows return oldest-first. */
export interface ProviderAuditEvent {
  at: number;
  kind: ProviderEventKind;
  detail: Record<string, unknown>;
}

export interface ProviderAuditQuery {
  cursor?: string;
  /** Inclusive unix epoch-second lower bound on `at`. */
  since?: number;
  limit?: number;
}

export interface ProviderAuditPage {
  events: ProviderAuditEvent[];
  nextCursor: string | null;
}

// ─── Layer 2 — backup store semantics ─────

/** One registry row: registration, listSnapshots and getSnapshot all return it. */
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
  /** Unix epoch seconds — every wire timestamp is an epoch-second integer. */
  createdAt: number;
  /** Unix epoch seconds, or null while the row is live. */
  prunedAt: number | null;
}

/** `POST /v1/storage/vaults/:id/snapshots` request body. */
export interface SnapshotRegistration {
  /** Provider MUST replay the prior result on retry. */
  idempotencyKey: string;
  /** MUST fall under the target's `backup` store prefix. */
  manifestKey: string;
  manifestHash: string;
  totalBytes: number;
  objectCount: number;
  /** Fencing token, >= 1. */
  generation: number;
  format: string;
  appMeta: Record<string, string>;
}

// ─── Errors (protocol-wide) ─────

/** Reserved codes; providers MAY add others. */
export type BackupProviderErrorCode =
  | "invalid_request"
  | "auth_expired"
  | "payment_required"
  | "interactive_auth_required"
  | "quota_exceeded"
  | "not_found"
  | "undelete_window_expired"
  | "conflict_generation"
  | "policy_unmet"
  | "purge_pending"
  | "provider_error";

/** PROTOCOL.md's status table. */
export const CODE_STATUS: Readonly<Record<BackupProviderErrorCode, number>> = {
  invalid_request: 400,
  auth_expired: 401,
  payment_required: 402,
  interactive_auth_required: 403,
  quota_exceeded: 403,
  not_found: 404,
  undelete_window_expired: 404,
  conflict_generation: 409,
  policy_unmet: 422,
  purge_pending: 409,
  provider_error: 502,
};

export interface BackupProviderErrorDetails {
  currentGeneration?: number;
  [key: string]: unknown;
}

/** Local and remote providers throw this same shape. */
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
    this.name = "BackupProviderError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  /** Reserved code; status comes from `CODE_STATUS`. */
  static of(
    code: BackupProviderErrorCode,
    message: string,
    details?: BackupProviderErrorDetails
  ): BackupProviderError {
    return new BackupProviderError({
      status: CODE_STATUS[code],
      code,
      message,
      details,
    });
  }
}

// ─── The provider seam ─────
// `conformance.ts` grades any implementation of it against the same cases.

export interface BackupProvider {
  capabilities: () => Promise<ProviderCapabilities>;

  createTarget: (opts: { label: string }) => Promise<{ targetId: string }>;
  deleteTarget: (targetId: string) => Promise<void>;
  undeleteTarget: (targetId: string) => Promise<void>;
  /** Local supports it (api-key tier); remote MUST throw `interactive_auth_required`. */
  purgeTarget: (targetId: string) => Promise<void>;

  /** Every provider MUST support `"backup"`; `"cas"` and `"derived"` MUST be
   *  supported when `capabilities` declares them. */
  openDataPlane: (
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write"
  ) => Promise<TypeImport_6gxkc6.ObjectStore>;

  /**
   * OPTIONAL: only a provider with a literal wire grant implements it. One whose
   * data plane is the caller's own custody omits it, and conformance then skips
   * the grant-shape assertions.
   */
  requestGrant?: (
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write",
    ttlSeconds?: number
  ) => Promise<S3Grant>;

  registerSnapshot: (
    targetId: string,
    reg: SnapshotRegistration
  ) => Promise<SnapshotRow>;
  listSnapshots: (
    targetId: string,
    opts?: { includePruned?: boolean }
  ) => Promise<SnapshotRow[]>;
  getSnapshot: (targetId: string, seq: number) => Promise<SnapshotRow>;

  getTarget: (targetId: string) => Promise<TargetInfo>;
  usage: (
    targetId: string
  ) => Promise<{ usage: Usage; accountStatus: AccountStatus }>;

  /** Present iff `capabilities` includes `"usage"`. */
  usageReport?: (targetId: string) => Promise<UsageByStore>;

  /** `policy` capability: declaration and provider-stamped echo. */
  putPolicy?: (
    targetId: string,
    policy: ProviderPolicyDeclaration
  ) => Promise<ProviderPolicy>;
  getPolicy?: (targetId: string) => Promise<ProviderPolicy>;

  /** `inventory` capability: provider-attested, per-store pages. */
  listInventory?: (
    targetId: string,
    query: ProviderInventoryQuery
  ) => Promise<ProviderInventoryPage>;

  /** `audit` capability: append-only lifecycle and custody events. */
  listEvents?: (
    targetId: string,
    query?: ProviderAuditQuery
  ) => Promise<ProviderAuditPage>;
}

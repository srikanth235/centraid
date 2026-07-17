/*
 * The `centraid-storage-provider/1` seam (PROTOCOL.md): everything a client
 * (the engine in this package) needs from an offsite storage provider, and
 * nothing about how the provider is implemented. Field names below are
 * copied verbatim from PROTOCOL.md's JSON examples — this file IS the wire
 * contract in TypeScript, so drift between prose and types is a bug in one
 * of them.
 *
 * Layering (PROTOCOL.md): Layer 1 is account + grants — generic across
 * store classes. Layer 2 is workload semantics layered on top, one per
 * store class (`backup`, `cas`, growing additively). Types below are
 * grouped the same way.
 */

// ---------------------------------------------------------------------------
// Layer 1 — Account & grants
// ---------------------------------------------------------------------------

/** The store classes this revision defines (PROTOCOL.md § Terminology). */
export type StoreClass = 'backup' | 'cas' | 'derived';

/** Every store class, as a runtime array — the single source of truth so
 *  guards that must enumerate them (inventory validation, usage loops,
 *  capability checks) can't drift from `StoreClass`. Order is stable. */
export const STORE_CLASSES = ['backup', 'cas', 'derived'] as const satisfies readonly StoreClass[];

/** Discovery's additive capability flags. A provider declares only the
 *  control-plane surfaces and store classes it actually offers. */
export type ProviderCapabilityFlag = StoreClass | 'usage' | 'policy' | 'inventory' | 'audit';

/** Named capability bundles a provider MAY advertise (PROTOCOL.md § Profiles).
 *  Additive and advisory — capability flags, not profiles, are the
 *  protocol-evolution seam. `/1` defines one: `home` (a household's primary
 *  managed offsite home — the "Hosted" product option — which MUST carry all
 *  seven of `backup`, `cas`, `derived`, `usage`, `policy`, `inventory`,
 *  `audit`). */
export type ProviderProfile = 'home';

/** Every known profile name, as a runtime array — the single source of truth
 *  for conformance's "only known profiles" and "home ⇒ all members" checks. */
export const PROVIDER_PROFILES = ['home'] as const satisfies readonly ProviderProfile[];

/** The seven capabilities a `home`-profile provider MUST declare
 *  (PROTOCOL.md § Profiles). `policy` is REQUIRED so the client's five-metric
 *  freshness contract has a declared cadence to anchor staleness against. */
export const HOME_PROFILE_CAPABILITIES = [
  'backup',
  'cas',
  'derived',
  'usage',
  'policy',
  'inventory',
  'audit',
] as const satisfies readonly ProviderCapabilityFlag[];

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

/** `backup`-store-scoped fields of the discovery document — present iff
 *  `capabilities` includes `"backup"` (PROTOCOL.md § Layer 2 — backup). */
export interface BackupDiscovery {
  softDeleteWindowDays: number;
  retention: Retention;
  restoreCostClass: 'free-egress' | 'metered-egress';
  /** Provider can make objects immutable. */
  objectLock: boolean;
  /** Data plane honors If-None-Match. */
  conditionalWrites: boolean;
}

/** `GET /v1/storage/provider` response — everything a client adapts to. */
export interface ProviderCapabilities {
  protocol: string[];
  dataPlane: 's3';
  /** Additive capability flags — see `ProviderCapabilityFlag`. */
  capabilities: ProviderCapabilityFlag[];
  /** OPTIONAL named capability bundles (PROTOCOL.md § Profiles). A declared
   *  `home` profile MUST carry all of `HOME_PROFILE_CAPABILITIES`. Absent ⇒
   *  no named profile (still conformant). */
  profiles?: ProviderProfile[];
  maxCredentialTtlSeconds: number;
  purgeAuthTier: 'api-key' | 'interactive';
  /** Present iff `capabilities` includes `"backup"`. */
  backup?: BackupDiscovery;
  /** OPTIONAL — the provider-declared list of S3 storage-class values
   *  (`x-amz-storage-class`) its data plane accepts on object-creating
   *  requests (PUT / CreateMultipartUpload / CopyObject), e.g. Cloudflare
   *  R2's `["STANDARD", "STANDARD_IA"]`. Absent ⇒ clients MUST NOT send the
   *  header at all; declared ⇒ the data plane MUST accept those values. */
  storageClasses?: string[];
}

/** `accountStatus` on the target list — surfaced so backups don't stop silently. */
export type AccountStatus = 'ok' | 'payment_due' | 'suspended';

/** Backup store's per-target usage, embedded in the target list (Layer 2,
 *  unchanged shape from `/1`'s original single-workload design). */
export interface Usage {
  storedBytes: number;
  objectCount: number;
  /** Optional — a provider may not cap storage. */
  quotaBytes?: number;
  /** Unix epoch seconds. Optional — a provider may not meter. */
  meteredAt?: number;
}

/** One row of `GET /v1/storage/vaults` — a storage target. */
export interface TargetInfo {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  usage: Usage;
}

/** Short-lived, store-and-prefix-scoped S3 credentials for the data plane
 *  (PROTOCOL.md § Credential grant). One target hosts one isolated prefix
 *  per store class it's granted for — `u/{id}/backup/`, `u/{id}/cas/`. */
export interface S3Grant {
  endpoint: string;
  /** REQUIRED — the data plane's real SigV4 region. `"auto"` remains a
   *  valid value (Cloudflare R2's profile); it is no longer a client-side
   *  hardcode (see `s3-store.ts`). */
  region: string;
  bucket: string;
  prefix: string;
  /** Echoes the store class this grant was issued for. */
  store: StoreClass;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: number;
  mode: 'read' | 'read-write';
}

/** Layer-1 optional `usage` capability — per-store-class report
 *  (PROTOCOL.md § Usage). Distinct from `Usage` above, which is the
 *  backup-store's own target-list-embedded figure. */
export interface StoreUsageReport {
  bytesStored: number;
  objectCount: number;
  /** Optional — provider-defined operation counters (e.g. `{"put": 12}`). */
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
  casAck: 'receipt' | 'replicated';
}

/** Provider echo. `declaredAt` is provider-stamped unix epoch seconds. */
export interface ProviderPolicy extends ProviderPolicyDeclaration {
  declaredAt: number;
}

/** Query for one store class's provider-attested inventory. */
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
  state: 'live' | 'soft-deleted';
}

export interface ProviderInventoryPage {
  store: StoreClass;
  objects: ProviderInventoryObject[];
  nextCursor: string | null;
}

export type ProviderEventKind =
  | 'prune'
  | 'soft-delete'
  | 'undelete'
  | 'purge'
  | 'credential-issued'
  | 'policy-changed';

/** Append-only provider audit row. Rows are returned oldest-first. */
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

// ---------------------------------------------------------------------------
// Layer 2 — backup store semantics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Errors (protocol-wide)
// ---------------------------------------------------------------------------

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
  | 'policy_unmet'
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
  policy_unmet: 422,
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

// ---------------------------------------------------------------------------
// The provider seam
// ---------------------------------------------------------------------------

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

  /** Store-class-scoped data plane handle (PROTOCOL.md § Layer 1 — per-store
   *  isolated prefixes). Every provider MUST support `"backup"`; `"cas"` and
   *  `"derived"` MUST each be supported when `capabilities` declares it. */
  openDataPlane(
    targetId: string,
    store: StoreClass,
    mode: 'read' | 'read-write',
  ): Promise<import('./object-store.js').ObjectStore>;

  /**
   * Layer-1 grant introspection (PROTOCOL.md § Credential grant) — OPTIONAL.
   * Only providers with a literal wire-grant concept (a real S3-compatible
   * data plane reached over HTTP, e.g. `RemoteBackupProvider`) implement
   * this. A provider whose data plane IS the caller's own custody (e.g.
   * `LocalBackupProvider`'s filesystem) has no grant to hand back and omits
   * it; conformance skips the grant-shape assertions when absent.
   */
  requestGrant?(
    targetId: string,
    store: StoreClass,
    mode: 'read' | 'read-write',
    ttlSeconds?: number,
  ): Promise<S3Grant>;

  registerSnapshot(targetId: string, reg: SnapshotRegistration): Promise<SnapshotRow>;
  listSnapshots(targetId: string, opts?: { includePruned?: boolean }): Promise<SnapshotRow[]>;
  getSnapshot(targetId: string, seq: number): Promise<SnapshotRow>;

  /** Includes `currentGeneration` and the backup store's `usage`. */
  getTarget(targetId: string): Promise<TargetInfo>;
  usage(targetId: string): Promise<{ usage: Usage; accountStatus: AccountStatus }>;

  /** Layer-1 optional `usage` capability (PROTOCOL.md § Usage) — per-store-class
   *  report. OPTIONAL; present iff `capabilities` includes `"usage"`. */
  usageReport?(targetId: string): Promise<UsageByStore>;

  /** Optional `policy` capability — declaration and provider-stamped echo. */
  putPolicy?(targetId: string, policy: ProviderPolicyDeclaration): Promise<ProviderPolicy>;
  getPolicy?(targetId: string): Promise<ProviderPolicy>;

  /** Optional `inventory` capability — provider-attested, per-store pages. */
  listInventory?(targetId: string, query: ProviderInventoryQuery): Promise<ProviderInventoryPage>;

  /** Optional `audit` capability — append-only lifecycle and custody events. */
  listEvents?(targetId: string, query?: ProviderAuditQuery): Promise<ProviderAuditPage>;
}

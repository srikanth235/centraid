import type * as TypeImport_6gxkc6 from "./object-store.js";

export type StoreClass = "backup" | "cas" | "derived";

export const STORE_CLASSES = [
  "backup",
  "cas",
  "derived",
] as const satisfies readonly StoreClass[];

export type ProviderCapabilityFlag =
  | StoreClass
  | "usage"
  | "policy"
  | "inventory"
  | "audit";

export type ProviderProfile = "home";

export const PROVIDER_PROFILES = [
  "home",
] as const satisfies readonly ProviderProfile[];

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
      keepAllDays: number;
      dailyDays: number;
      weeklyDays: number;
      neverPruneNewest: true;
    }
  | { kind: "none" };

export interface BackupDiscovery {
  softDeleteWindowDays: number;
  retention: Retention;
  restoreCostClass: "free-egress" | "metered-egress";
  objectLock: boolean;
  conditionalWrites: boolean;
}

export interface ProviderCapabilities {
  protocol: string[];
  dataPlane: "s3";
  capabilities: ProviderCapabilityFlag[];
  profiles?: ProviderProfile[];
  maxCredentialTtlSeconds: number;
  purgeAuthTier: "api-key" | "interactive";
  backup?: BackupDiscovery;
  storageClasses?: string[];
}

export type AccountStatus = "ok" | "payment_due" | "suspended";

export interface Usage {
  storedBytes: number;
  objectCount: number;
  quotaBytes?: number;
  meteredAt?: number;
}

export interface TargetInfo {
  id: string;
  name: string;
  status: "active" | "deleted";
  currentGeneration: number;
  usage: Usage;
}

export interface S3Grant {
  endpoint: string;
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

export interface StoreUsageReport {
  bytesStored: number;
  objectCount: number;
  opCounts?: Record<string, number>;
  quotaBytes: number | null;
  period: { start: number; end: number };
}

export type UsageByStore = Partial<Record<StoreClass, StoreUsageReport>>;

export interface ProviderPolicyDeclaration {
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  casAck: "receipt" | "replicated";
}

export interface ProviderPolicy extends ProviderPolicyDeclaration {
  declaredAt: number;
}

export interface ProviderInventoryQuery {
  store: StoreClass;
  cursor?: string;
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

export interface ProviderAuditEvent {
  at: number;
  kind: ProviderEventKind;
  detail: Record<string, unknown>;
}

export interface ProviderAuditQuery {
  cursor?: string;
  since?: number;
  limit?: number;
}

export interface ProviderAuditPage {
  events: ProviderAuditEvent[];
  nextCursor: string | null;
}

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
  createdAt: number;
  prunedAt: number | null;
}

export interface SnapshotRegistration {
  idempotencyKey: string;
  manifestKey: string;
  manifestHash: string;
  totalBytes: number;
  objectCount: number;
  generation: number;
  format: string;
  appMeta: Record<string, string>;
}

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

export interface BackupProvider {
  capabilities: () => Promise<ProviderCapabilities>;

  createTarget: (opts: { label: string }) => Promise<{ targetId: string }>;
  deleteTarget: (targetId: string) => Promise<void>;
  undeleteTarget: (targetId: string) => Promise<void>;
  purgeTarget: (targetId: string) => Promise<void>;

  openDataPlane: (
    targetId: string,
    store: StoreClass,
    mode: "read" | "read-write"
  ) => Promise<TypeImport_6gxkc6.ObjectStore>;

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

  usageReport?: (targetId: string) => Promise<UsageByStore>;

  putPolicy?: (
    targetId: string,
    policy: ProviderPolicyDeclaration
  ) => Promise<ProviderPolicy>;
  getPolicy?: (targetId: string) => Promise<ProviderPolicy>;

  listInventory?: (
    targetId: string,
    query: ProviderInventoryQuery
  ) => Promise<ProviderInventoryPage>;

  listEvents?: (
    targetId: string,
    query?: ProviderAuditQuery
  ) => Promise<ProviderAuditPage>;
}

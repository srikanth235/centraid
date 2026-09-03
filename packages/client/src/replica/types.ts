export const REPLICA_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_REPLICA_PURPOSE = "dpv:ServiceProvision";
export const REPLICA_SYNTHETIC_PRIMARY_KEY = "__centraid_row_id" as const;

export type ReplicaScalar = null | boolean | number | string;
export type ReplicaValue =
  | ReplicaScalar
  | ReplicaValue[]
  | { [key: string]: ReplicaValue };
export type ReplicaRow = Record<string, ReplicaValue>;

export interface ReplicaIdentity {
  /** Stable, transport-independent gateway/profile identity. */
  gatewayId: string;
  vaultId: string;
}

export interface ReplicaCursor {
  epoch: string;
  seq: number;
}

export interface ReplicaEntitySchema {
  entity: string;
  primaryKey: string;
  /** Columns remaining after the daemon has applied the shape's field mask. */
  columns: string[];
  /** Undisclosed fields exist; neither their names nor values are replicated. */
  hasUnavailableFields?: boolean;
}

export interface ReplicaShape {
  shapeId: string;
  appId: string;
  purpose: string;
  entities: ReplicaEntitySchema[];
}

export interface ReplicaSnapshotRow {
  shapeId: string;
  entity: string;
  rowId: string;
  values: ReplicaRow;
  /** Latest canonical change sequence for this row in the current epoch. */
  rowVersion?: number;
  oversizedFields?: string[];
}

/**
 * Everything a replica needs before any row lands: identity, schema epoch, shape
 * catalog. A snapshot carries it with its rows; a windowed bootstrap takes it
 * from page 1.
 */
export interface ReplicaBootstrapHeader {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  vaultId: string;
  schemaEpoch: string;
  shapes: ReplicaShape[];
}

export interface ReplicaSnapshot extends ReplicaBootstrapHeader {
  cursor: ReplicaCursor;
  rows: ReplicaSnapshotRow[];
  /** Device-scoped durable results reconcile an IDB outbox after a long offline period. */
  outcomes?: IntentOutcome[];
}

export interface ReplicaUpsertChange extends ReplicaSnapshotRow {
  op: "upsert";
  commitId?: string;
}

export interface ReplicaDeleteChange {
  op: "delete";
  commitId?: string;
  rowVersion?: number;
  shapeId: string;
  entity: string;
  rowId: string;
}

export type ReplicaChange = ReplicaUpsertChange | ReplicaDeleteChange;

export type IntentOutcomeStatus =
  | "executed"
  | "parked"
  | "denied"
  | "failed"
  | "conflict";

export interface ReplicaConflict {
  shapeId?: string;
  entity: string;
  rowId: string;
  expectedVersion: number;
  actualVersion: number;
}

export interface IntentOutcome {
  intentId: string;
  status: IntentOutcomeStatus;
  reason?: string;
  output?: ReplicaValue;
  conflict?: ReplicaConflict;
  /** Durable local settlement time, when retained by an outbox journal. */
  settledAt?: string;
}

export interface ReplicaChangeBatch {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  schemaEpoch: string;
  from: ReplicaCursor;
  to: ReplicaCursor;
  changes: ReplicaChange[];
  outcomes?: IntentOutcome[];
  /** True when another complete commit group remains after this page. */
  hasMore?: boolean;
}

export type ReplicaFilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "is-null"
  | "not-null"
  | "within-days"
  | "within-next-days";

export interface ReplicaFilterClause {
  column: string;
  op: ReplicaFilterOperator;
  value?: ReplicaValue;
}

export interface ReplicaOrderBy {
  column: string;
  /** Default `asc`. Ties use an exposed scalar primary key ascending; opaque ties rerun online. */
  dir?: "asc" | "desc";
}

export interface ReplicaReadRequest {
  shapeId: string;
  entity: string;
  where?: ReplicaFilterClause[];
  orderBy?: ReplicaOrderBy;
  limit?: number;
  purpose?: string;
  /**
   * "I have not declared a window; give me the default one and tell me when it
   * fills." The kit boundary refuses a read that sets neither this nor `limit`
   * (#922 0a) — the engine never silently caps a caller that did not ask.
   */
  acceptTruncation?: boolean;
}

/**
 * Bounded local equivalent of the vault search plane. Eligible only where the
 * shape holds the complete indexed text; anything else fails OnlineOnlyError.
 */
export interface ReplicaSearchRequest {
  shapeId: string;
  entity: string;
  query: string;
  where?: ReplicaFilterClause[];
  limit?: number;
  purpose?: string;
  /** As on a read (#922 0a): the caller takes the default window knowingly. */
  acceptTruncation?: boolean;
}

export interface ReplicaDependency {
  shapeId: string;
  entity: string;
  /** The one row this dependency is confined to. ABSENT MEANS THE WHOLE
   *  ENTITY, which is what the engine emits today (#883). */
  rowId?: string;
}

export interface ReplicaRowEnvelope {
  rowId: string;
  values: ReplicaRow;
  oversizedFields: string[];
  hasUnavailableFields: boolean;
  rowVersion?: number;
}

/**
 * TRUNCATION IS NEVER SILENT (#922 0a). `coverage` answers "does this device
 * hold the whole library yet"; these two answer the different question "did
 * THIS read's window cut the answer short" — a fully bootstrapped replica
 * still truncates a 5,000-contact roster at the default 1,000. Both are
 * additive and absent when the window did not fill.
 */
export interface ReplicaTruncation {
  /** Set only when rows were left behind. Absent is not `false` by accident:
   *  a producer that cannot tell must not claim completeness. */
  truncated?: boolean;
  /** The window that produced `rows`, so a surface can name the number. */
  appliedLimit?: number;
}

export interface ReplicaReadWireResult extends ReplicaTruncation {
  rows: ReplicaRowEnvelope[];
  cursor: ReplicaCursor;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaSearchWireResult extends ReplicaTruncation {
  rows: ReplicaRowEnvelope[];
  cursor: ReplicaCursor;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaReadResult extends ReplicaTruncation {
  rows: ReplicaRow[];
  /** No consent receipt locally; the cursor makes the origin inspectable. */
  receiptId: string;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaSearchResult extends ReplicaTruncation {
  rows: ReplicaRow[];
  /** No consent receipt locally; the cursor makes the origin inspectable. */
  receiptId: string;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export type ReplicaMode = "opfs-sahpool" | "memory" | "native";

export type ReplicaCoverage = "partial" | "complete";
export type ReplicaDurability = "durable" | "memory";

export interface ReplicaWorkerOpenOptions {
  dbName: string;
  vaultId: string;
  remember: boolean;
  /** Terminal cleanup mode: OPFS must open and no memory fallback is allowed. */
  purgeOnly?: boolean;
}

export interface ReplicaStatus {
  mode: ReplicaMode;
  cursor: ReplicaCursor | null;
  schemaEpoch: string | null;
  coverage?: ReplicaCoverage;
  durability?: ReplicaDurability;
  /** Durability of the intent outbox, which is a separate browser store. */
  intentDurability?: ReplicaDurability;
}

export interface OptimisticUpsert {
  op: "upsert";
  shapeId: string;
  entity: string;
  rowId: string;
  values: ReplicaRow;
}

export interface OptimisticDelete {
  op: "delete";
  shapeId: string;
  entity: string;
  rowId: string;
}

export type OptimisticMutation = OptimisticUpsert | OptimisticDelete;

export type IntentState =
  | "queued"
  | "sending"
  | "awaiting-change"
  | "parked"
  | "executed"
  | "denied"
  | "failed";

export interface ReplicaIntent {
  intentId: string;
  /** SHA-256 of canonical {appId, action, input, baseVersions}; daemon verifies id reuse. */
  payloadHash: string;
  appId: string;
  action: string;
  input: ReplicaValue;
  state: IntentState;
  createdOrder: number;
  attempts: number;
  /** First admission, ISO-8601. Absent on rows queued before the stamp existed. */
  enqueuedAt?: string;
  optimistic: OptimisticMutation[];
  /** App-visible replica reads that must receive this intent's settlement signal. */
  dependencies?: ReplicaDependency[];
  reason?: string;
  output?: ReplicaValue;
  /** Optional optimistic concurrency preconditions captured by the app. */
  baseVersions?: ReplicaBaseVersion[];
  conflict?: ReplicaConflict;
}

export interface ReplicaBaseVersion {
  shapeId?: string;
  entity: string;
  rowId: string;
  version: number;
}

export interface EnqueueIntentInput {
  intentId?: string;
  appId: string;
  action: string;
  input: ReplicaValue;
  optimistic?: OptimisticMutation[];
  dependencies?: ReplicaDependency[];
  baseVersions?: ReplicaBaseVersion[];
}

export interface ReplicaInvalidation extends ReplicaDependency {
  rowId?: string;
  source: "canonical" | "overlay" | "purge";
  /** Present for local optimistic/outcome invalidations so apps can narrate settlement. */
  intentId?: string;
  intentState?: IntentState;
}

export interface ApplyChangesResult {
  cursor: ReplicaCursor;
  invalidations: ReplicaInvalidation[];
  outcomes: IntentOutcome[];
}

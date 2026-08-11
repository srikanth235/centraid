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
 * Everything a replica needs before any row lands: identity, the schema epoch
 * and the shape catalog. A single-shot snapshot carries it alongside its rows;
 * a windowed bootstrap takes it from page 1 and streams rows across pages.
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

/** Terminal statuses that hold a row on screen until a member answers them. */
export type IntentAttentionStatus = "denied" | "conflict" | "failed";

/**
 * One settled-but-unexecuted write the member still has to answer for (issue
 * #738): denied, conflicted, or failed. The outbox drops the intent on settle,
 * so without this journal the projected row would leave every read and a
 * denied CREATE would silently disappear — the exact defect class the issue
 * names. This record is what makes "the row persists with the explanation and
 * edit/retry/discard" survive a reload.
 *
 * It is a CLIENT-LOCAL journal, not wire state: nothing here is sent to a
 * gateway and no intent schema changes.
 *
 * `input` is retained deliberately, against `settle`'s scrub-the-queued-input
 * rule. The rule exists because a settled intent has no remaining use for its
 * payload; an attention row does — it is the only thing edit/retry can
 * re-issue from. Withholding it would not withhold the member's content
 * either, since `optimistic` already carries the projected values the row
 * renders. Retention is bounded by the member's own answer: `dismissAttention`
 * (discard or retry) deletes the record, and `clear`/`destroy` wipe the
 * journal with the rest of the outbox. Executed and parked outcomes journal
 * nothing.
 */
export interface IntentAttentionRecord {
  intentId: string;
  status: IntentAttentionStatus;
  appId: string;
  action: string;
  reason?: string;
  /** The projection the row re-renders from after a reload. */
  optimistic: OptimisticMutation[];
  /** The app's own payload, for edit/retry. */
  input?: ReplicaValue;
  /** Expected vs actual versions, so a conflict row can say which. */
  conflict?: ReplicaConflict;
  settledAt: string;
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
}

/**
 * Bounded local equivalent of the vault search plane. Only replica search
 * surfaces whose complete indexed text is present in the shape are eligible;
 * unsupported entities/features fail with a typed OnlineOnlyError.
 */
export interface ReplicaSearchRequest {
  shapeId: string;
  entity: string;
  query: string;
  where?: ReplicaFilterClause[];
  limit?: number;
  purpose?: string;
}

export interface ReplicaDependency {
  shapeId: string;
  entity: string;
}

export interface ReplicaRowEnvelope {
  rowId: string;
  values: ReplicaRow;
  oversizedFields: string[];
  hasUnavailableFields: boolean;
  rowVersion?: number;
}

export interface ReplicaReadWireResult {
  rows: ReplicaRowEnvelope[];
  cursor: ReplicaCursor;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaSearchWireResult {
  rows: ReplicaRowEnvelope[];
  cursor: ReplicaCursor;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaReadResult {
  rows: ReplicaRow[];
  /** Local reads have no consent receipt; the cursor makes their origin inspectable. */
  receiptId: string;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaSearchResult {
  rows: ReplicaRow[];
  /** Local searches have no consent receipt; the cursor makes their origin inspectable. */
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

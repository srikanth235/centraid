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
  columns: string[];
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
  rowVersion?: number;
  oversizedFields?: string[];
}

export interface ReplicaBootstrapHeader {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  vaultId: string;
  schemaEpoch: string;
  shapes: ReplicaShape[];
}

export interface ReplicaSnapshot extends ReplicaBootstrapHeader {
  cursor: ReplicaCursor;
  rows: ReplicaSnapshotRow[];
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
  settledAt?: string;
}

export interface ReplicaChangeBatch {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  schemaEpoch: string;
  from: ReplicaCursor;
  to: ReplicaCursor;
  changes: ReplicaChange[];
  outcomes?: IntentOutcome[];
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
  rowId?: string;
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
  receiptId: string;
  dependency: ReplicaDependency;
  coverage?: ReplicaCoverage;
}

export interface ReplicaSearchResult {
  rows: ReplicaRow[];
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
  purgeOnly?: boolean;
}

export interface ReplicaStatus {
  mode: ReplicaMode;
  cursor: ReplicaCursor | null;
  schemaEpoch: string | null;
  coverage?: ReplicaCoverage;
  durability?: ReplicaDurability;
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
  payloadHash: string;
  appId: string;
  action: string;
  input: ReplicaValue;
  state: IntentState;
  createdOrder: number;
  attempts: number;
  enqueuedAt?: string;
  optimistic: OptimisticMutation[];
  dependencies?: ReplicaDependency[];
  reason?: string;
  output?: ReplicaValue;
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
  intentId?: string;
  intentState?: IntentState;
}

export interface ApplyChangesResult {
  cursor: ReplicaCursor;
  invalidations: ReplicaInvalidation[];
  outcomes: IntentOutcome[];
}

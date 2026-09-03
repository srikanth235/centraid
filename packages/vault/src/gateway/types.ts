import type { DatabaseSync } from "node:sqlite";

export interface ExecutionScopeSpec {
  schema: string;
  table?: string;
  verbs: "read" | "read+act" | "act" | "reveal";
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

export type Credential =
  | { kind: "app"; appId: string; signingKey: string }
  | {
      kind: "agent";
      agentId: string;
      deviceId: string;
      deviceKey: string;
      scopeClamp?: readonly ExecutionScopeSpec[];
      onBehalfOfOwner?: { ownerId: string; mayAct: boolean };
    }
  | { kind: "device"; deviceId: string; deviceKey: string };

export type Risk = "low" | "medium" | "high";

export const DEFAULT_PURPOSE = "dpv:ServiceProvision";

export interface Identity {
  kind: "app" | "agent" | "owner-device";
  callerId: string;
  provAgentKind: "app" | "ai_agent" | "owner";
  partyId: string | null;
  mayAct: boolean;
  scopeClamp?: readonly ExecutionScopeSpec[];
  onBehalfOfOwner?: { ownerId: string; mayAct: boolean };
}

export interface FilterClause {
  column: string;
  op:
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
  value?: unknown;
}

export interface OrderBy {
  column: string;
  dir?: "asc" | "desc";
}

export interface ReadRequest {
  entity: string;
  where?: FilterClause[];
  orderBy?: OrderBy;
  limit?: number;
  purpose?: string;
}

export interface SearchRequest {
  entity: string;
  query: string;
  where?: FilterClause[];
  limit?: number;
  purpose?: string;
}

export interface InvokeRequest {
  command: string;
  input: Record<string, unknown>;
  purpose?: string;
  invocationId?: string;
  intentId?: string;
  intentDeviceId?: string;
  actingOwnerId?: string;
  demo?: { appId: string };
}

export interface ReadResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

export interface SearchResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

export interface ChangesRequest {
  entities: string[];
  purpose?: string;
  cursor: string | null;
  limit?: number;
}

export interface ChangeEntry {
  provId: string;
  entity: string;
  entityId: string;
  activity: string;
  agentKind: "owner" | "app" | "ai_agent" | "import";
  occurredAt: string;
}

export interface ChangesResult {
  changes: ChangeEntry[];
  cursor: string;
  receiptId: string;
}

export type InvokeOutcome =
  | {
      status: "executed";
      invocationId: string;
      receiptId: string;
      output: unknown;
    }
  | { status: "parked"; invocationId: string; reason: string }
  | {
      status: "denied";
      invocationId?: string;
      receiptId: string;
      reason: string;
    }
  | {
      status: "failed";
      invocationId: string;
      receiptId: string;
      reason: string;
      predicate?: string;
    }
  | { status: "replayed"; invocationId: string; output: unknown };

export type ParkedCallerKind = "app" | "agent" | "assistant" | "owner-device";

export interface ParkedSummary {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: ParkedCallerKind;
  callerId: string;
  caller: string | null;
  input: Record<string, unknown>;
}

export interface ConditionSpec {
  name: string;
  sql: string;
  column: string;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
  value: number | string;
  message?: string;
}

export interface Citation {
  claim: string;
  entityType: string;
  entityId: string;
  weight?: number;
}

export interface HandlerBlobs {
  staged: (sha256: string) => {
    mediaType: string;
    byteSize: number;
    originalName: string | null;
    meta: Record<string, unknown>;
  } | null;
  claimStaged: (
    sha256: string,
    options?: { title?: string }
  ) => {
    contentId: string;
    mediaType: string;
    byteSize: number;
    meta: Record<string, unknown>;
    deduped: 0 | 1;
  };
  spill: (bytes: Buffer) => string;
  has: (sha256: string) => boolean;
}

export interface HandlerReceipt {
  grantId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  decision: "allow" | "deny";
  detail?: Record<string, unknown>;
}

export interface HandlerCtx {
  db: DatabaseSync;
  identity: Identity;
  invocationId: string;
  input: Record<string, unknown>;
  purpose: string;
  now: string;
  newId: () => string;
  wrote: (entityType: string, entityId: string) => void;
  cite: (citation: Citation) => void;
  receipt: (receipt: HandlerReceipt) => void;
  unseal: (
    entityType: string,
    entityId: string,
    column: string,
    ciphertext?: string
  ) => string | null;
  blobs: HandlerBlobs;
}

export interface CommandHandler {
  name: string;
  execute: (ctx: HandlerCtx) => Record<string, unknown>;
}

export interface CommandDefinition {
  name: string;
  ownerSchema: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  preconditions: ConditionSpec[];
  postconditions: ConditionSpec[];
  idempotency: "idempotent" | "once" | "retry-safe";
  risk: Risk;
  confirm?: boolean;
  handler: CommandHandler["execute"];
  sealedInput?: readonly string[];
  unseals?: readonly string[];
  transcriptSensitive?: boolean;
  erasure?: boolean;
}

export interface RevealRequest {
  entity: string;
  entityId?: string;
  alias?: string;
  columns?: string[];
  context?: { kind: "fill"; origin: string };
  authentication?: { sessionToken?: string; itemToken?: string };
  purpose?: string;
}

export interface RevealResult {
  values: Record<string, string | null>;
  receiptId: string;
}

export class GatewayError extends Error {
  constructor(
    readonly stage: "identity" | "access" | "contract" | "execution",
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

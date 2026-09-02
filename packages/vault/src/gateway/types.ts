// Shared types for the gateway pipeline (§10): identity → consent → contract
// → execution → evidence.

import type { DatabaseSync } from "node:sqlite";

export interface ExecutionScopeSpec {
  schema: string;
  table?: string;
  verbs: "read" | "read+act" | "act" | "reveal";
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

/** Every caller authenticates as a ROW (S1). */
export type Credential =
  | { kind: "app"; appId: string; signingKey: string }
  | {
      kind: "agent";
      agentId: string;
      deviceId: string;
      deviceKey: string;
      /** Intersected with the agent's durable grants, which stay the cap. */
      scopeClamp?: readonly ExecutionScopeSpec[];
      /**
       * The L2 owner this turn acts ON BEHALF OF (#599). The host resolves
       * ownership; the vault enforces one bit — such an agent must fail a
       * write exactly where that owner would. Absent caps nothing.
       */
      onBehalfOfOwner?: { ownerId: string; mayAct: boolean };
    }
  | { kind: "device"; deviceId: string; deviceKey: string };

export type Risk = "low" | "medium" | "high";

/**
 * Purposes are off the critical path (#306): a request naming none journals
 * this. The vocabulary stays for the day sharing brings a second party.
 */
export const DEFAULT_PURPOSE = "dpv:ServiceProvision";

export interface Identity {
  kind: "app" | "agent" | "owner-device";
  callerId: string;
  provAgentKind: "app" | "ai_agent" | "owner";
  partyId: string | null;
  /** readonly devices may read but never act. */
  mayAct: boolean;
  /** Authenticated per-execution attenuation, never caller-supplied data. */
  scopeClamp?: readonly ExecutionScopeSpec[];
  /** Carried from the credential; independent of `mayAct` on purpose. */
  onBehalfOfOwner?: { ownerId: string; mayAct: boolean };
}

export interface FilterClause {
  column: string;
  /**
   * `within-days` looks BACK (col ≥ now − N days: "happened recently");
   * `within-next-days` looks FORWARD (now ≤ col ≤ now + N days: "due soon" —
   * the horizon window condition triggers ride).
   */
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

/**
 * The column is validated against the table's real columns — caller strings
 * never become SQL text. PKs are UUIDv7, so ordering by an id IS time order.
 */
export interface OrderBy {
  column: string;
  /** Default `asc`; ties break on a scalar PK in ascending BINARY order. */
  dir?: "asc" | "desc";
}

export interface ReadRequest {
  entity: string;
  /** Caller-supplied filter, ANDed with the grant's row filter. */
  where?: FilterClause[];
  /** Without this, a `limit` picks arbitrary rows, not recent ones. */
  orderBy?: OrderBy;
  limit?: number;
  /** Declared DPV purpose. Absent = `DEFAULT_PURPOSE` (#306). */
  purpose?: string;
}

/**
 * `query` is whatever the owner typed: tokenized and quoted before it becomes
 * an FTS5 MATCH, so FTS operators in user text stay literals, never syntax.
 */
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
  /** Idempotent replay: the same id returns the recorded outcome (§10 S4). */
  invocationId?: string;
  /**
   * Kept with the confirmation payload, so a later owner decision can publish
   * the terminal intent outcome through the replica log.
   */
  intentId?: string;
  intentDeviceId?: string;
  /**
   * Resolved by the HOST from the device binding, never caller-supplied (#599
   * decision 8). The id is the attribution key; labels are display only.
   */
  actingOwnerId?: string;
  /**
   * Demo register (#290): provenance stamps `seed.demo` and every write lands
   * in the seed registry, so it purges in one act and stays invisible to the
   * automation plane. Owner-device only.
   */
  demo?: { appId: string };
}

export interface ReadResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

/**
 * Best first (bm25); rows carry grant-masked columns plus `_rank` and
 * `_snippet`, marked with `⟦`/`⟧`. Renderers MUST escape the fragment before
 * turning the markers into markup — no vault text ever ships as HTML.
 */
export interface SearchResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

/**
 * `cursor` is the last `prov_id` consumed (UUIDv7, strictly time-ordered);
 * `null` bootstraps to the watermark so a new trigger replays no history.
 */
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

/**
 * Refines `Identity['kind']`'s `'agent'` into `'assistant'` for the vault
 * assistant (`_assistant`, `invokeAsAssistant`): same credential shape, very
 * different meaning to an owner approving a parked act.
 */
export type ParkedCallerKind = "app" | "agent" | "assistant" | "owner-device";

/**
 * The pause between draft and send only means something if the owner can read
 * what they confirm: `caller` says WHO, `input` says WHAT.
 */
export interface ParkedSummary {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: ParkedCallerKind;
  /**
   * The enrolled row id — a stable key, unlike `caller`. "My own parked
   * invocations" matches on THIS, never on the display name.
   */
  callerId: string;
  caller: string | null;
  input: Record<string, unknown>;
}

export interface ConditionSpec {
  name: string;
  /** SELECT returning ONE row; named params bind from command input. */
  sql: string;
  column: string;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
  value: number | string;
  /**
   * Owner-facing sentence replacing the raw predicate on failure — the
   * author's words, not a debugging string. The raw predicate is the fallback.
   */
  message?: string;
}

export interface Citation {
  claim: string;
  entityType: string;
  entityId: string;
  weight?: number;
}

/**
 * Pure row work over bytes already in the local CAS (#296): a command never
 * does byte I/O beyond the synchronous local tier, so the transaction stays
 * the unit of truth.
 */
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
  /** The small data_uri path (§3): custody moves bytes out of the row. */
  spill: (bytes: Buffer) => string;
  has: (sha256: string) => boolean;
}

/** `grantId` names the standing answer the entry is ABOUT (#883). */
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
  /**
   * The invocation this handler is running under (#916, review 5.2). A
   * snapshot, a receipt and a replica change that cannot be joined to the
   * command that caused them are three unrelated facts.
   */
  invocationId: string;
  input: Record<string, unknown>;
  /** Handlers making further consent checks must reuse THIS purpose. */
  purpose: string;
  now: string;
  newId: () => string;
  wrote: (entityType: string, entityId: string) => void;
  cite: (citation: Citation) => void;
  /**
   * ONE receipt of this handler's own, beside the invocation's (#883). Queued
   * like `cite`, never written here: the audit band stamps the receipt chain
   * (seq, prev-hash) after the handler returns, so writing one in-handler
   * would break chain order. Since ONE FILE (#916) the receipt commits in the
   * same transaction as the write, so a rolled-back write takes it with it.
   */
  receipt: (receipt: HandlerReceipt) => void;
  /**
   * Derivatives without revelation (#293 decision 5): the plaintext never
   * crosses the command boundary. Only cells declared in `unseals` resolve,
   * and every unseal is noted on the receipt — column names, never values.
   */
  unseal: (
    entityType: string,
    entityId: string,
    column: string,
    /**
     * A ciphertext to unseal instead of the row's current value — a
     * pre-mutation SNAPSHOT of the same row (#916, D2). The additional data is
     * the row's, so only a value that really came from this cell decrypts.
     */
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
  /** Salience only (#306 decision 2) — NOT an approval trigger; see `confirm`. */
  risk: Risk;
  /**
   * A non-owner invocation PARKS regardless of risk (#306 decision 1).
   * Reserved for semantic egress and consent-state or irreversible acts;
   * everything else runs on the install-time grant and is reviewed after.
   */
  confirm?: boolean;
  handler: CommandHandler["execute"];
  /**
   * Secret-bearing input keys (#293 decision 4). The journal is append-only,
   * so these are hash-tokenized before the invocation row and in every
   * parked-summary payload; the handler still receives the raw input.
   */
  sealedInput?: readonly string[];
  /** `<entity>.<column>`; `ctx.unseal` refuses anything not declared here. */
  unseals?: readonly string[];
  /**
   * The output derives from secret material and must not persist anywhere
   * durable (#298): this redacts it from the journal receipt while the live
   * caller still receives the real value.
   */
  transcriptSensitive?: boolean;
  /**
   * THIS COMMAND ERASES (#916). A pre-mutation snapshot is the vault's memory
   * of what a row said before; for a command whose whole purpose is that the
   * row is FORGOTTEN — `media.forget_person`, a purge — a snapshot is a copy
   * of exactly what the member asked to be destroyed, sitting where a later
   * export would carry it out. The pipeline discards the capture instead of
   * recording it.
   */
  erasure?: boolean;
}

export interface RevealRequest {
  entity: string;
  entityId?: string;
  /**
   * `locker.item` only (#298 item 4): the alias maps to the live item under
   * the same reveal grant, so a connector binding survives delete+recreate.
   * Exactly one of entityId/alias.
   */
  alias?: string;
  columns?: string[];
  context?: { kind: "fill"; origin: string };
  /** Memory-only presence proof, consumed once and NEVER journaled. */
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

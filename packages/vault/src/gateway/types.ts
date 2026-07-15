// Shared types for the gateway pipeline (§10): identity → consent → contract
// → execution → evidence.

import type { DatabaseSync } from 'node:sqlite';

/** How a caller proves who it is (S1). Every caller authenticates as a row. */
export type Credential =
  | { kind: 'app'; appId: string; signingKey: string }
  | { kind: 'agent'; agentId: string; deviceId: string; deviceKey: string }
  | { kind: 'device'; deviceId: string; deviceKey: string };

export type Risk = 'low' | 'medium' | 'high';

/**
 * The auto-defaulted DPV purpose (issue #306 decision 4): purposes are off
 * the critical path — a request that names none journals this notation. The
 * vocabulary and `consent.policy` purpose rules stay for the day sharing
 * reintroduces a genuine second party.
 */
export const DEFAULT_PURPOSE = 'dpv:ServiceProvision';

/** Resolved caller identity after S1. */
export interface Identity {
  kind: 'app' | 'agent' | 'owner-device';
  /** Row id of the authenticated caller (app_id / agent_id / device_id). */
  callerId: string;
  /** prov:Agent class stamped on provenance rows. */
  provAgentKind: 'app' | 'ai_agent' | 'owner';
  /** Party the caller acts as, when it has one (agents, owner devices). */
  partyId: string | null;
  /** readonly devices may read but never act. */
  mayAct: boolean;
}

/** One predicate of a row filter (ODRL-constraint shaped, compiled to SQL). */
export interface FilterClause {
  column: string;
  /**
   * `within-days` looks BACK (col ≥ now − N days: "happened recently");
   * `within-next-days` looks FORWARD (now ≤ col ≤ now + N days: "due soon" —
   * the horizon window condition triggers ride).
   */
  op:
    | 'eq'
    | 'ne'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'in'
    | 'is-null'
    | 'not-null'
    | 'within-days'
    | 'within-next-days';
  value?: unknown;
}

/**
 * Deterministic ordering for a read. The column is validated against the
 * table's real columns (the same allow-list discipline as FilterClause) —
 * caller strings never become SQL text. PKs are UUIDv7, so ordering by an
 * id column IS time order on tables that carry no timestamp.
 */
export interface OrderBy {
  column: string;
  /** Default `asc`. Ties use an exposed scalar primary key in ascending BINARY order. */
  dir?: 'asc' | 'desc';
}

export interface ReadRequest {
  /** Logical entity, e.g. `core.event`. */
  entity: string;
  /** Caller-supplied filter, ANDed with the grant's row filter. */
  where?: FilterClause[];
  /**
   * With `limit`, this is what makes a bounded window a RECENT window —
   * an unordered LIMIT picks arbitrary rows.
   */
  orderBy?: OrderBy;
  limit?: number;
  /** Declared DPV purpose. Absent = `DEFAULT_PURPOSE` (issue #306). */
  purpose?: string;
}

/**
 * Full-text search over a text-indexed entity — read-shaped consent, index-
 * shaped execution. `query` is whatever the owner typed: it is tokenized and
 * quoted before it becomes an FTS5 MATCH (implicit AND, prefix on every
 * word), so FTS operators in user text are literals, never syntax.
 */
export interface SearchRequest {
  /** Logical entity, e.g. `knowledge.note`. Must be text-searchable. */
  entity: string;
  /** Owner-typed words. */
  query: string;
  /** Caller-supplied filter, ANDed with the grant's row filter. */
  where?: FilterClause[];
  limit?: number;
  purpose?: string;
}

export interface InvokeRequest {
  /** Registered command name, e.g. `schedule.propose_event`. */
  command: string;
  input: Record<string, unknown>;
  purpose?: string;
  /**
   * Caller-supplied invocation id for idempotent replay: re-sending the same
   * id returns the recorded outcome instead of re-executing (§10 S4).
   */
  invocationId?: string;
  /**
   * Browser-replica intent that caused this invocation. The gateway keeps it
   * with a confirmation-gated payload so a later owner decision can publish
   * the terminal intent outcome through the replica log.
   */
  intentId?: string;
  /**
   * The demo register (issue #290 phase 1): rows this invocation writes are
   * scenario-seed data — provenance stamps `seed.demo` instead of the
   * command activity, and every write lands in the seed registry so it is
   * purgeable in one act and invisible to the automation plane. Owner-device
   * only; `appId` names the scenario's app for per-app reset.
   */
  demo?: { appId: string };
}

export interface ReadResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

/**
 * Matches, best first (bm25). Each row carries the grant-masked base columns
 * plus `_rank` and `_snippet` — the matched fragment with `⟦`/`⟧` around each
 * hit. Renderers must escape the fragment BEFORE turning the markers into
 * markup; the markers exist so no vault text is ever shipped as HTML.
 */
export interface SearchResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

/**
 * A consented pull over the append-only provenance stream — the outbox data
 * triggers ride. `cursor` is the last `prov_id` the caller consumed
 * (UUIDv7, so strictly time-ordered); `null` bootstraps: no rows, just the
 * current watermark, so a new trigger doesn't replay the vault's history.
 */
export interface ChangesRequest {
  /** Logical entities to watch, e.g. `['core.transaction']`. Each is consent-checked for read. */
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
  agentKind: 'owner' | 'app' | 'ai_agent' | 'import';
  occurredAt: string;
}

export interface ChangesResult {
  changes: ChangeEntry[];
  /** New watermark to persist. Unchanged when no rows matched. */
  cursor: string;
  receiptId: string;
}

export type InvokeOutcome =
  | { status: 'executed'; invocationId: string; receiptId: string; output: unknown }
  | { status: 'parked'; invocationId: string; reason: string }
  | { status: 'denied'; invocationId?: string; receiptId: string; reason: string }
  | {
      status: 'failed';
      invocationId: string;
      receiptId: string;
      reason: string;
      predicate?: string;
    }
  | { status: 'replayed'; invocationId: string; output: unknown };

/**
 * The requester kind an approval surface renders as a trust-legibility
 * badge. Refines `Identity['kind']`'s `'agent'` into `'assistant'` when the
 * enrolled agent IS the vault assistant (`_assistant`, `invokeAsAssistant`)
 * rather than an automation's acting identity — the two ride the same
 * credential shape but mean very different things to the owner deciding
 * whether to approve a parked act.
 */
export type ParkedCallerKind = 'app' | 'agent' | 'assistant' | 'owner-device';

/**
 * One invocation awaiting owner confirmation, as the consent surface lists
 * it. `caller` is the display name — consent.app.display_name (falling
 * back to a humanized app id) for apps, the agent's core.party display
 * name for agents — so an approval UI can say WHO wants the act; `input`
 * is the command input so it can say WHAT. The pause between draft and
 * send is only meaningful when the owner can read what they're confirming.
 */
export interface ParkedSummary {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: ParkedCallerKind;
  /**
   * The caller's enrolled row id (`consent_app.app_id` / `agent_agent.agent_id`)
   * — a stable identity key, unlike `caller` (a display name, which can
   * change). `ctx.vault`'s "my own parked invocations" op matches on this,
   * never on the display name.
   */
  callerId: string;
  /** Display name of the caller (consent.app.display_name for apps), or null. */
  caller: string | null;
  input: Record<string, unknown>;
}

/** Declarative pre/postcondition stored in agent.command *_json (§03). */
export interface ConditionSpec {
  name: string;
  /** SELECT returning one row; named params bind from command input. */
  sql: string;
  /** Column of that row to compare. */
  column: string;
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
  value: number | string;
  /**
   * Owner-facing sentence shown in place of the raw `name: column op value`
   * predicate when this condition fails — every command author's own
   * words, not a debugging string. Optional so existing conditions keep
   * working (raw predicate stays the fallback); backfill the high-traffic
   * ones first.
   */
  message?: string;
}

/** Evidence citation a handler reports (S5: explanation is citation). */
export interface Citation {
  claim: string;
  entityType: string;
  entityId: string;
  weight?: number;
}

/**
 * The blob surface inside a command (issue #296): pure row work over bytes
 * that already sit in the local CAS — a command never does byte I/O beyond
 * the synchronous local tier, so the transaction stays the unit of truth.
 */
export interface HandlerBlobs {
  /** Staged, unclaimed info for a sha (null = nothing staged). */
  staged(sha256: string): {
    mediaType: string;
    byteSize: number;
    originalName: string | null;
    meta: Record<string, unknown>;
  } | null;
  /**
   * Claim a staged sha into a canonical content item — the promotion from
   * "bytes waiting" to "model" (issue #296 §3). Idempotent over dedup:
   * a live content item already owning the sha restores + returns.
   */
  claimStaged(
    sha256: string,
    options?: { title?: string },
  ): {
    contentId: string;
    mediaType: string;
    byteSize: number;
    meta: Record<string, unknown>;
    deduped: 0 | 1;
  };
  /**
   * Spill raw bytes into the local CAS and return their sha — the small
   * data_uri compatibility path (§3): the command already holds the bytes,
   * custody moves them out of the row.
   */
  spill(bytes: Buffer): string;
  /** Local CAS presence — precondition-grade, no bytes returned. */
  has(sha256: string): boolean;
}

/** Transaction-scoped surface handed to command handlers. */
export interface HandlerCtx {
  /** vault.db handle, inside the command's ACID transaction. */
  db: DatabaseSync;
  identity: Identity;
  input: Record<string, unknown>;
  /** Declared DPV purpose of the invocation — for handlers that must make
   * further consent checks (e.g. core.link_entities requires read of both
   * endpoints under the same purpose the act rode in on). */
  purpose: string;
  now: string;
  newId(): string;
  /** Record a write so the gateway stamps consent.provenance for it. */
  wrote(entityType: string, entityId: string): void;
  /** Cite a row the command read to justify its action. */
  cite(citation: Citation): void;
  /**
   * Decrypt one sealed cell INSIDE the command (issue #293 decision 5):
   * derivatives without revelation — `locker.totp_code` unseals the seed,
   * returns the 6 digits, and the seed never crosses the command boundary.
   * Only cells the command declares in `unseals` resolve; every unseal is
   * noted on the command's receipt (column names, never values). Plaintext
   * legacy values return as-is; a missing row/column returns null.
   */
  unseal(entityType: string, entityId: string, column: string): string | null;
  /** Blob custody surface (issue #296) — staged claims and data_uri spills. */
  blobs: HandlerBlobs;
}

/** Domain-owned command implementation, hosted and checked by the gateway. */
export interface CommandHandler {
  name: string;
  execute(ctx: HandlerCtx): Record<string, unknown>;
}

/** Registration payload: the agent.command row + its handler. */
export interface CommandDefinition {
  name: string;
  ownerSchema: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  preconditions: ConditionSpec[];
  postconditions: ConditionSpec[];
  idempotency: 'idempotent' | 'once' | 'retry-safe';
  /**
   * Salience marker (issue #306 decision 2): journaled on every invocation
   * receipt and used to rank the owner's review feed — NOT an approval
   * trigger. Parking rides `confirm` alone.
   */
  risk: Risk;
  /**
   * Tier 3/4 marker (issue #306 decision 1): the command is loud on purpose —
   * a non-owner invocation PARKS for explicit owner confirmation regardless
   * of risk. Reserved for semantic egress (sends, publishes) and
   * consent-state or irreversible acts (trust widening, merges). Everything
   * else executes under the caller's install-time grant and is reviewed
   * after the fact.
   */
  confirm?: boolean;
  handler: CommandHandler['execute'];
  /**
   * Input keys carrying secret material (issue #293 decision 4). The journal
   * is append-only — these keys are replaced with a keyed hash token before
   * the invocation row is written, and in every parked-summary payload. The
   * handler still receives the raw input.
   */
  sealedInput?: readonly string[];
  /**
   * Sealed cells this command may decrypt internally, as
   * `<entity>.<column>` (e.g. `locker.item.otp_seed`). `ctx.unseal` refuses
   * anything not declared here.
   */
  unseals?: readonly string[];
  /**
   * The output is derived from secret material and must not persist in any
   * durable store (issue #298 item 6). `locker.totp_code` returns a live
   * 6-digit code from an unsealed seed; low-stakes (30s TTL) but the one
   * crack in "secrets never enter durable transcripts". Marking it here
   * redacts the OUTPUT from the vault journal receipt (which otherwise keeps
   * it for replay) while the live caller still receives the real value.
   */
  transcriptSensitive?: boolean;
}

/** A reveal: plaintext of one entity's sealed columns (issue #293). */
export interface RevealRequest {
  /** Logical entity, e.g. `locker.item`. Must have sealed columns. */
  entity: string;
  entityId?: string;
  /**
   * Resolve the target by a stable alias instead of entityId (issue #298
   * item 4): `locker.item` only. The gateway maps the alias to the live
   * item under the same reveal grant, so a connector binding survives the
   * delete+recreate rotation gesture. Exactly one of entityId/alias.
   */
  alias?: string;
  /** Sealed columns to reveal. Default: all of the entity's sealed columns. */
  columns?: string[];
  purpose?: string;
}

export interface RevealResult {
  /** column → plaintext (null where the cell is empty). */
  values: Record<string, string | null>;
  receiptId: string;
}

export class GatewayError extends Error {
  constructor(
    readonly stage: 'identity' | 'consent' | 'contract' | 'execution',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

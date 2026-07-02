// Shared types for the gateway pipeline (§10): identity → consent → contract
// → execution → evidence.

import type { DatabaseSync } from 'node:sqlite';

/** How a caller proves who it is (S1). Every caller authenticates as a row. */
export type Credential =
  | { kind: 'app'; appId: string; signingKey: string }
  | { kind: 'agent'; agentId: string; deviceId: string; deviceKey: string }
  | { kind: 'device'; deviceId: string; deviceKey: string };

export type Risk = 'low' | 'medium' | 'high';

/** Resolved caller identity after S1. */
export interface Identity {
  kind: 'app' | 'agent' | 'owner-device';
  /** Row id of the authenticated caller (app_id / agent_id / device_id). */
  callerId: string;
  /** prov:Agent class stamped on provenance rows. */
  provAgentKind: 'app' | 'ai_agent' | 'owner';
  /** Party the caller acts as, when it has one (agents, owner devices). */
  partyId: string | null;
  /**
   * Highest command risk executable without per-action owner confirmation.
   * Apps carry consent.app.risk_ceiling; agents default to medium (risk=high
   * always requires confirmation per §03); the owner confirms by acting.
   */
  riskCeiling: Risk | 'owner';
  /** readonly devices may read but never act. */
  mayAct: boolean;
}

/** One predicate of a row filter (ODRL-constraint shaped, compiled to SQL). */
export interface FilterClause {
  column: string;
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'is-null' | 'not-null' | 'within-days';
  value?: unknown;
}

export interface ReadRequest {
  /** Logical entity, e.g. `core.event`. */
  entity: string;
  /** Caller-supplied filter, ANDed with the grant's row filter. */
  where?: FilterClause[];
  limit?: number;
  /** Declared DPV purpose, e.g. `dpv:ServiceProvision`. */
  purpose: string;
}

export interface InvokeRequest {
  /** Registered command name, e.g. `schedule.propose_event`. */
  command: string;
  input: Record<string, unknown>;
  purpose: string;
  /**
   * Caller-supplied invocation id for idempotent replay: re-sending the same
   * id returns the recorded outcome instead of re-executing (§10 S4).
   */
  invocationId?: string;
}

export interface ReadResult {
  rows: Record<string, unknown>[];
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

/** Declarative pre/postcondition stored in agent.command *_json (§03). */
export interface ConditionSpec {
  name: string;
  /** SELECT returning one row; named params bind from command input. */
  sql: string;
  /** Column of that row to compare. */
  column: string;
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
  value: number | string;
}

/** Evidence citation a handler reports (S5: explanation is citation). */
export interface Citation {
  claim: string;
  entityType: string;
  entityId: string;
  weight?: number;
}

/** Transaction-scoped surface handed to command handlers. */
export interface HandlerCtx {
  /** vault.db handle, inside the command's ACID transaction. */
  db: DatabaseSync;
  identity: Identity;
  input: Record<string, unknown>;
  now: string;
  newId(): string;
  /** Record a write so the gateway stamps consent.provenance for it. */
  wrote(entityType: string, entityId: string): void;
  /** Cite a row the command read to justify its action. */
  cite(citation: Citation): void;
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
  risk: Risk;
  handler: CommandHandler['execute'];
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

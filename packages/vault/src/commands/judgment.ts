// The learning loop's write surface (issue #310 C1, rule R08). The tables
// and the veto have existed since v1 — agent_correction, agent_judgment,
// and judgmentVeto() consulted on every execution — but nothing ever WROTE
// them: the loop's promise ("corrections feed back as durable judgment
// rows") was a dead letter. These commands close it in its honest, manual
// form:
//
//   record_correction — any granted actor records that the owner fixed
//     something (the diff, the target, the reason). Apps funnel the owner's
//     gesture; the assistant records its own overrides.
//   distill_judgment — OWNER-ONLY: turning corrections into a standing rule
//     that vetoes future commands is a consent-plane act, exactly like an
//     outbox standing grant. A judgment may cite the correction it distills.
//   revoke_judgment — OWNER-ONLY: learning is rows, auditable and revocable.
//
// Automatic distillation (a model proposing rules from correction streams)
// is assistant-side work that lands ON this surface — the assistant calls
// distill_judgment and the owner's confirm-gate rides in front of it like
// any other elevated act. No parallel mechanism.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { resolveEntity } from '../schema/tables.js';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

function requireOwner(ctx: HandlerCtx, refusal: string): void {
  if (ctx.identity.kind !== 'owner-device') throw new Error(refusal);
}

const RECORD_CORRECTION: CommandDefinition = {
  name: 'agent.record_correction',
  ownerSchema: 'agent',
  inputSchema: {
    type: 'object',
    required: ['target_type', 'target_id', 'after'],
    additionalProperties: false,
    properties: {
      target_type: { type: 'string', minLength: 1 },
      target_id: { type: 'string', minLength: 1 },
      before: { type: 'object' },
      after: { type: 'object' },
      reason: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['correction_id'],
    properties: { correction_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'correction_recorded',
      sql: 'SELECT count(*) AS n FROM agent_correction WHERE correction_id = :correction_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      target_type: string;
      target_id: string;
      before?: Record<string, unknown>;
      after: Record<string, unknown>;
      reason?: string;
    };
    // The corrected thing must be a real canonical row — a correction about
    // nothing teaches nothing.
    const ref = resolveEntity(input.target_type, ctx.db);
    if (!ref || ref.file !== 'vault')
      throw new Error(`target_type names unknown entity "${input.target_type}"`);
    const pkRow = ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`).all() as {
      name: string;
      pk: number;
    }[];
    const pk = pkRow.find((r) => r.pk === 1)?.name;
    if (!pk) throw new Error(`no primary key on ${ref.physical}`);
    const live = ctx.db
      .prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`)
      .get(input.target_id);
    if (!live) throw new Error(`no ${input.target_type} with id ${input.target_id}`);

    const correctionId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO agent_correction
           (correction_id, invocation_id, corrected_by_party_id, target_type, target_id, before_json, after_json, reason, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        correctionId,
        actorPartyId(ctx),
        input.target_type,
        input.target_id,
        input.before ? JSON.stringify(input.before) : null,
        JSON.stringify(input.after),
        input.reason ?? null,
        ctx.now,
      );
    ctx.wrote('agent.correction', correctionId);
    ctx.cite({
      claim: `correction recorded on ${input.target_type}`,
      entityType: input.target_type,
      entityId: input.target_id,
    });
    return { correction_id: correctionId };
  },
};

const DISTILL_JUDGMENT: CommandDefinition = {
  name: 'agent.distill_judgment',
  ownerSchema: 'agent',
  inputSchema: {
    type: 'object',
    required: ['subject_scope', 'rule'],
    additionalProperties: false,
    properties: {
      // A schema name ('social') or a full command name ('social.send_message').
      subject_scope: { type: 'string', minLength: 1 },
      // The one rule shape the contract evaluator consults today.
      rule: {
        type: 'object',
        required: ['veto_command'],
        additionalProperties: false,
        properties: { veto_command: { type: 'string', minLength: 1 } },
      },
      correction_id: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      expires_at: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['judgment_id'],
    properties: { judgment_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'judgment_active',
      sql: 'SELECT count(*) AS n FROM agent_judgment WHERE judgment_id = :judgment_id AND active = 1',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'medium',
  handler: (ctx) => {
    requireOwner(ctx, "distilling a standing judgment is the owner's act (rule R08)");
    const input = ctx.input as {
      subject_scope: string;
      rule: { veto_command: string };
      correction_id?: string;
      confidence?: number;
      expires_at?: string;
    };
    if (input.correction_id) {
      const live = ctx.db
        .prepare('SELECT 1 AS x FROM agent_correction WHERE correction_id = ?')
        .get(input.correction_id);
      if (!live) throw new Error(`no agent.correction with id ${input.correction_id}`);
    }
    const judgmentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO agent_judgment
           (judgment_id, derived_from_correction_id, subject_scope, rule_json, confidence, active, learned_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        judgmentId,
        input.correction_id ?? null,
        input.subject_scope,
        JSON.stringify(input.rule),
        input.confidence ?? 1,
        ctx.now,
        input.expires_at ?? null,
      );
    ctx.wrote('agent.judgment', judgmentId);
    ctx.cite({
      claim: `standing judgment learned: veto ${input.rule.veto_command} within ${input.subject_scope}`,
      entityType: 'agent.judgment',
      entityId: judgmentId,
    });
    return { judgment_id: judgmentId };
  },
};

const REVOKE_JUDGMENT: CommandDefinition = {
  name: 'agent.revoke_judgment',
  ownerSchema: 'agent',
  inputSchema: {
    type: 'object',
    required: ['judgment_id'],
    additionalProperties: false,
    properties: { judgment_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['judgment_id'],
    properties: { judgment_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'judgment_is_active',
      sql: 'SELECT count(*) AS n FROM agent_judgment WHERE judgment_id = :judgment_id AND active = 1',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'judgment_inactive',
      sql: 'SELECT count(*) AS n FROM agent_judgment WHERE judgment_id = :judgment_id AND active = 0',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    requireOwner(ctx, "revoking a judgment is the owner's act");
    const input = ctx.input as { judgment_id: string };
    ctx.db
      .prepare('UPDATE agent_judgment SET active = 0 WHERE judgment_id = ?')
      .run(input.judgment_id);
    ctx.wrote('agent.judgment', input.judgment_id);
    return { judgment_id: input.judgment_id };
  },
};

/** Register the judgment-loop commands on a gateway. */
export function registerJudgmentCommands(gateway: Gateway): void {
  gateway.registerCommand(RECORD_CORRECTION);
  gateway.registerCommand(DISTILL_JUDGMENT);
  gateway.registerCommand(REVOKE_JUDGMENT);
}

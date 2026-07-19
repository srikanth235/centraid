// Finance domain commands (§07): the ledger is append-mostly — a
// recategorization is a classification change with provenance, never an
// amount edit; balances and budget progress are projections, never stored.
// split_txn carries the doc's Σ-invariant as a postcondition: splits must sum
// to the parent amount or the whole write rolls back.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';

const CATEGORIZE_TXN: CommandDefinition = {
  name: 'finance.categorize_txn',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['txn_id', 'category_concept_id'],
    additionalProperties: false,
    properties: {
      txn_id: { type: 'string', minLength: 1 },
      category_concept_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['txn_id', 'category_concept_id'],
    properties: { txn_id: { type: 'string' }, category_concept_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'txn_exists',
      sql: 'SELECT count(*) AS n FROM core_transaction WHERE txn_id = :txn_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'category_exists',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :category_concept_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Classification changed; the amount is untouchable by construction —
      // no command exposes it.
      name: 'category_applied',
      sql: `SELECT count(*) AS n FROM core_transaction
             WHERE txn_id = :txn_id AND category_concept_id = :category_concept_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: categorizeTxn,
};

function categorizeTxn(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { txn_id: string; category_concept_id: string };
  ctx.db
    .prepare('UPDATE core_transaction SET category_concept_id = ? WHERE txn_id = ?')
    .run(input.category_concept_id, input.txn_id);
  ctx.wrote('core.transaction', input.txn_id);
  ctx.cite({
    claim: `transaction reclassified to concept ${input.category_concept_id}; amount untouched`,
    entityType: 'core.transaction',
    entityId: input.txn_id,
  });
  return { txn_id: input.txn_id, category_concept_id: input.category_concept_id };
}

const SPLIT_TXN: CommandDefinition = {
  name: 'finance.split_txn',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['txn_id', 'splits'],
    additionalProperties: false,
    properties: {
      txn_id: { type: 'string', minLength: 1 },
      splits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['amount_minor', 'category_concept_id'],
          additionalProperties: false,
          properties: {
            amount_minor: { type: 'integer' },
            category_concept_id: { type: 'string', minLength: 1 },
            memo: { type: 'string' },
          },
        },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['txn_id', 'split_count'],
    properties: { txn_id: { type: 'string' }, split_count: { type: 'integer' } },
  },
  preconditions: [
    {
      name: 'txn_exists',
      sql: 'SELECT count(*) AS n FROM core_transaction WHERE txn_id = :txn_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The Σ-invariant (§03 finance.txn_split): SUM(splits) = parent amount.
      name: 'splits_sum_to_parent',
      sql: `SELECT (
              (SELECT COALESCE(SUM(amount_minor), 0) FROM finance_txn_split WHERE txn_id = :txn_id)
              = (SELECT amount_minor FROM core_transaction WHERE txn_id = :txn_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'medium',
  handler: splitTxn,
};

function splitTxn(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    txn_id: string;
    splits: { amount_minor: number; category_concept_id: string; memo?: string }[];
  };
  // Replace-not-append: splits are behavior rows over an immutable movement.
  ctx.db.prepare('DELETE FROM finance_txn_split WHERE txn_id = ?').run(input.txn_id);
  for (const split of input.splits) {
    const splitId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO finance_txn_split (split_id, txn_id, amount_minor, category_concept_id, memo)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        splitId,
        input.txn_id,
        split.amount_minor,
        split.category_concept_id,
        split.memo ?? null,
      );
    ctx.wrote('finance.txn_split', splitId);
  }
  ctx.cite({
    claim: `movement decomposed into ${input.splits.length} categorized slice(s)`,
    entityType: 'core.transaction',
    entityId: input.txn_id,
  });
  return { txn_id: input.txn_id, split_count: input.splits.length };
}

const SET_BUDGET: CommandDefinition = {
  name: 'finance.set_budget',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['category_concept_id', 'period', 'limit_minor', 'currency', 'starts_on'],
    additionalProperties: false,
    properties: {
      category_concept_id: { type: 'string', minLength: 1 },
      period: { type: 'string', enum: ['month', 'quarter', 'year'] },
      limit_minor: { type: 'integer', minimum: 0 },
      currency: { type: 'string', minLength: 3 },
      starts_on: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['budget_id'],
    properties: { budget_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'category_exists',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :category_concept_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // A cap exists; progress against it stays a projection, never a row.
      name: 'budget_recorded',
      sql: `SELECT count(*) AS n FROM finance_budget WHERE budget_id = :budget_id AND limit_minor = :limit_minor`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: setBudget,
};

function setBudget(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    category_concept_id: string;
    period: string;
    limit_minor: number;
    currency: string;
    starts_on: string;
  };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  const existing = ctx.db
    .prepare(
      `SELECT budget_id FROM finance_budget
        WHERE owner_party_id = ? AND category_concept_id = ? AND period = ? AND starts_on = ?`,
    )
    .get(owner.owner_party_id, input.category_concept_id, input.period, input.starts_on) as
    | { budget_id: string }
    | undefined;
  let budgetId: string;
  if (existing) {
    budgetId = existing.budget_id;
    ctx.db
      .prepare('UPDATE finance_budget SET limit_minor = ?, currency = ? WHERE budget_id = ?')
      .run(input.limit_minor, input.currency, budgetId);
  } else {
    budgetId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO finance_budget (budget_id, owner_party_id, category_concept_id, period, limit_minor, currency, starts_on)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        budgetId,
        owner.owner_party_id,
        input.category_concept_id,
        input.period,
        input.limit_minor,
        input.currency,
        input.starts_on,
      );
  }
  ctx.wrote('finance.budget', budgetId);
  return { budget_id: budgetId };
}

const REMOVE_BUDGET: CommandDefinition = {
  name: 'finance.remove_budget',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['budget_id'],
    additionalProperties: false,
    properties: {
      budget_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['budget_id'],
    properties: { budget_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'budget_exists',
      sql: 'SELECT count(*) AS n FROM finance_budget WHERE budget_id = :budget_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The cap is gone; the ledger is untouched — a budget is a limit over
      // spending, never spending itself.
      name: 'budget_removed',
      sql: 'SELECT count(*) AS n FROM finance_budget WHERE budget_id = :budget_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: removeBudget,
};

function removeBudget(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { budget_id: string };
  ctx.db.prepare('DELETE FROM finance_budget WHERE budget_id = ?').run(input.budget_id);
  cleanupPolyRefs(ctx.db, ctx.now, 'finance.budget', input.budget_id);
  ctx.wrote('finance.budget', input.budget_id);
  return { budget_id: input.budget_id };
}

const FLAG_ANOMALY: CommandDefinition = {
  name: 'finance.flag_anomaly',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['txn_id', 'reason'],
    additionalProperties: false,
    properties: {
      txn_id: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['tag_id'],
    properties: { tag_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'txn_exists',
      sql: 'SELECT count(*) AS n FROM core_transaction WHERE txn_id = :txn_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'not_already_flagged',
      sql: `SELECT count(*) AS n FROM core_tag t
             JOIN core_concept c ON c.concept_id = t.concept_id
            WHERE t.target_type = 'core.transaction' AND t.target_id = :txn_id AND c.notation = 'anomaly'`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'anomaly_tagged',
      sql: `SELECT count(*) AS n FROM core_tag
             WHERE target_type = 'core.transaction' AND target_id = :txn_id AND tag_id = :tag_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: flagAnomaly,
};

function flagAnomaly(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { txn_id: string; reason: string; confidence?: number };
  const concept = ctx.db
    .prepare(`SELECT concept_id FROM core_concept WHERE notation = 'anomaly'`)
    .get() as { concept_id: string } | undefined;
  if (!concept) throw new Error(`vocabulary missing 'anomaly' concept — reseed flags scheme`);
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, 'core.transaction', ?, ?, ?, ?, ?)`,
    )
    .run(
      tagId,
      input.txn_id,
      concept.concept_id,
      ctx.identity.partyId,
      input.confidence ?? null,
      ctx.now,
    );
  ctx.wrote('core.tag', tagId);
  ctx.cite({
    claim: `anomaly flagged: ${input.reason}`,
    entityType: 'core.transaction',
    entityId: input.txn_id,
    weight: input.confidence ?? 1,
  });
  return { tag_id: tagId };
}

/** Register the finance domain's commands on a gateway. */
export function registerFinanceCommands(gateway: Gateway): void {
  gateway.registerCommand(CATEGORIZE_TXN);
  gateway.registerCommand(SPLIT_TXN);
  gateway.registerCommand(SET_BUDGET);
  gateway.registerCommand(REMOVE_BUDGET);
  gateway.registerCommand(FLAG_ANOMALY);
}

// Subscriptions (finance §05): a finance_recurring_series is the vault's
// model of "money that repeats" — an account, a cadence (rrule), an expected
// amount, and a tolerance band the reconciler matches real transactions
// against. These commands let a projection declare and retire series;
// matching a posted transaction to a series stays the reconciler's job.
// Distinct from Budgets (category spend): this answers "what renews, and
// what am I bleeding monthly." All low risk — declaring a subscription
// touches no outward party and no ledger row.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

const ADD_SUBSCRIPTION: CommandDefinition = {
  name: 'finance.add_subscription',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['account_id', 'expected_minor', 'rrule'],
    additionalProperties: false,
    properties: {
      account_id: { type: 'string', minLength: 1 },
      expected_minor: { type: 'integer', minimum: 1 },
      rrule: { type: 'string', minLength: 1 },
      counterparty_party_id: { type: 'string', minLength: 1 },
      tolerance_pct: { type: 'integer', minimum: 0, maximum: 100 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['series_id'],
    properties: { series_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'account_exists',
      sql: 'SELECT count(*) AS n FROM core_account WHERE account_id = :account_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'counterparty_exists_if_given',
      sql: `SELECT CASE WHEN :counterparty_party_id IS NULL THEN 1
                 ELSE (SELECT count(*) FROM core_party WHERE party_id = :counterparty_party_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'series_created_active',
      sql: `SELECT count(*) AS n FROM finance_recurring_series WHERE series_id = :series_id AND status = 'active'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addSubscription,
};

function addSubscription(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    account_id: string;
    expected_minor: number;
    rrule: string;
    counterparty_party_id?: string;
    tolerance_pct?: number;
  };
  const seriesId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO finance_recurring_series
         (series_id, account_id, counterparty_party_id, rrule, expected_minor, tolerance_pct, last_txn_id, status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'active')`,
    )
    .run(
      seriesId,
      input.account_id,
      input.counterparty_party_id ?? null,
      input.rrule,
      input.expected_minor,
      input.tolerance_pct ?? 10,
    );
  ctx.wrote('finance.recurring_series', seriesId);
  return { series_id: seriesId };
}

const SET_SUBSCRIPTION_STATUS: CommandDefinition = {
  name: 'finance.set_subscription_status',
  ownerSchema: 'finance',
  inputSchema: {
    type: 'object',
    required: ['series_id', 'status'],
    additionalProperties: false,
    properties: {
      series_id: { type: 'string', minLength: 1 },
      // paused = temporarily silent; ended = cancelled for good.
      status: { type: 'string', enum: ['active', 'paused', 'ended'] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['series_id', 'status'],
    properties: { series_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'series_exists',
      sql: 'SELECT count(*) AS n FROM finance_recurring_series WHERE series_id = :series_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'status_applied',
      sql: `SELECT count(*) AS n FROM finance_recurring_series WHERE series_id = :series_id AND status = :status`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: setSubscriptionStatus,
};

function setSubscriptionStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { series_id: string; status: string };
  ctx.db
    .prepare('UPDATE finance_recurring_series SET status = ? WHERE series_id = ?')
    .run(input.status, input.series_id);
  ctx.wrote('finance.recurring_series', input.series_id);
  ctx.cite({
    claim: `subscription ${input.series_id} → ${input.status}`,
    entityType: 'finance.recurring_series',
    entityId: input.series_id,
  });
  return { series_id: input.series_id, status: input.status };
}

/** Register the subscription commands on a gateway. */
export function registerSubscriptionCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_SUBSCRIPTION);
  gateway.registerCommand(SET_SUBSCRIPTION_STATUS);
}

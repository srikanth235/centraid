/**
 * ONE TALLY LEDGER, SEEDED INTO A REPLICA (#922 E7).
 *
 * Three friends, a group, multi-payer and single-payer expenses, a settlement,
 * an obligation, a recurring template with an exception, and a trashed expense
 * — so a dashboard derived from it carries non-zero balances rather than an
 * empty shell. Shared by the two parity oracles that must run over IDENTICAL
 * rows: the phone's own replica-vs-row-array comparison here, and the
 * phone-vs-web comparison in
 * `tests/integration-mobile/tally-balance-parity.integration.test.ts`. Sharing
 * the seed is what makes "the same rows" a fact rather than a claim.
 */

import { seedSeatTables } from "./seat-fixture.test-fixtures";
import type { SeedEntity } from "./seat-fixture.test-fixtures";

export const VAULT_ID = "personal";
export const OWNER = "party-owner";
export const FRIENDS = ["party-ana", "party-bo", "party-cy"] as const;

export type { SeedEntity } from "./seat-fixture.test-fixtures";

/**
 * A ledger with real arithmetic in it: three friends, a group, multi-payer and
 * single-payer expenses, a settlement, an obligation and a trashed expense, so
 * the compared output carries non-zero balances rather than two empty shells.
 */
export function seedEntities(): SeedEntity[] {
  const expenses: Array<Record<string, unknown>> = [];
  const splits: Array<Record<string, unknown>> = [];
  const payers: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 40; index += 1) {
    const expenseId = `expense-${String(index).padStart(3, "0")}`;
    const payer = index % 4 === 0 ? OWNER : FRIENDS[index % 3]!;
    expenses.push({
      expense_id: expenseId,
      group_id: "group-flat",
      paid_by: payer,
      amount_minor: 1200 + index * 25,
      description: `Expense ${index}`,
      category: "groceries",
      spent_on: `2026-0${(index % 9) + 1}-1${index % 9}`,
      split_method: "equal",
      split_params_json: null,
      deleted_at: null,
      purge_at: null,
    });
    const share = Math.floor((1200 + index * 25) / 4);
    for (const party of [OWNER, ...FRIENDS])
      splits.push({
        expense_id: expenseId,
        party_id: party,
        share_minor: share,
      });
    payers.push({
      expense_id: expenseId,
      party_id: payer,
      paid_minor: 1200 + index * 25,
    });
  }
  expenses.push({
    expense_id: "expense-trashed",
    group_id: "group-flat",
    paid_by: OWNER,
    amount_minor: 9999,
    description: "Returned",
    category: "shopping",
    spent_on: "2026-02-02",
    split_method: "equal",
    split_params_json: null,
    deleted_at: "2026-03-01T00:00:00.000Z",
    purge_at: "2026-04-01T00:00:00.000Z",
  });

  return [
    {
      entity: "core.vault",
      primaryKey: "vault_id",
      columns: ["vault_id", "self_party_id", "base_currency"],
      rows: [
        { vault_id: VAULT_ID, self_party_id: OWNER, base_currency: "GBP" },
      ],
    },
    {
      entity: "core.party",
      primaryKey: "party_id",
      columns: ["party_id", "display_name"],
      rows: [OWNER, ...FRIENDS].map((party_id) => ({
        party_id,
        display_name: party_id.replace("party-", "Person "),
      })),
    },
    {
      entity: "tally.friend",
      primaryKey: "party_id",
      seatColumns: ["friend_id", "party_id", "created_at"],
      columns: ["party_id"],
      rows: FRIENDS.map((party_id) => ({ party_id })),
    },
    {
      entity: "tally.group",
      primaryKey: "group_id",
      seatColumns: [
        "group_id",
        "circle_id",
        "icon",
        "color",
        "simplify_opt_in",
        "archived_at",
        "currency",
      ],
      columns: [
        "group_id",
        "circle_id",
        "icon",
        "color",
        "simplify_opt_in",
        "archived_at",
      ],
      rows: [
        {
          group_id: "group-flat",
          circle_id: "circle-flat",
          icon: "home",
          color: "ink",
          simplify_opt_in: 1,
          archived_at: null,
        },
        {
          group_id: "group-old",
          circle_id: "circle-old",
          icon: "home",
          color: "ink",
          simplify_opt_in: 0,
          archived_at: "2025-12-01T00:00:00.000Z",
        },
      ],
    },
    {
      entity: "social.circle",
      primaryKey: "circle_id",
      seatColumns: ["circle_id", "owner_party_id", "name", "kind"],
      columns: ["circle_id", "name"],
      rows: [
        { circle_id: "circle-flat", name: "14 Sitwell Road" },
        { circle_id: "circle-old", name: "Old House" },
      ],
    },
    {
      entity: "social.circle_member",
      primaryKey: "member_id",
      columns: ["member_id", "circle_id", "party_id"],
      rows: [OWNER, ...FRIENDS].map((party_id) => ({
        member_id: `member-${party_id}`,
        circle_id: "circle-flat",
        party_id,
      })),
    },
    {
      entity: "tally.expense",
      primaryKey: "expense_id",
      seatColumns: [
        "expense_id",
        "group_id",
        "description",
        "amount_minor",
        "currency",
        "paid_by",
        "split_method",
        "split_params_json",
        "spent_on",
        "category",
        "txn_id",
        "created_at",
        "updated_at",
        "deleted_at",
        "purge_at",
      ],
      columns: [
        "expense_id",
        "group_id",
        "paid_by",
        "amount_minor",
        "description",
        "category",
        "spent_on",
        "split_method",
        "split_params_json",
        "deleted_at",
        "purge_at",
      ],
      rows: expenses,
    },
    {
      entity: "tally.expense_split",
      primaryKey: "split_id",
      columns: ["split_id", "expense_id", "party_id", "share_minor"],
      rows: splits.map((row, index) => ({
        split_id: `split-${index}`,
        ...row,
      })),
    },
    {
      entity: "tally.expense_payer",
      primaryKey: "payer_id",
      columns: ["payer_id", "expense_id", "party_id", "paid_minor"],
      rows: payers.map((row, index) => ({
        payer_id: `payer-${index}`,
        ...row,
      })),
    },
    {
      entity: "tally.settlement",
      primaryKey: "settlement_id",
      seatColumns: [
        "settlement_id",
        "group_id",
        "from_party",
        "to_party",
        "amount_minor",
        "currency",
        "paid_on",
        "txn_id",
        "created_at",
        "deleted_at",
      ],
      columns: [
        "settlement_id",
        "from_party",
        "to_party",
        "amount_minor",
        "group_id",
        "deleted_at",
      ],
      rows: [
        {
          settlement_id: "settle-1",
          from_party: OWNER,
          to_party: "party-ana",
          amount_minor: 5000,
          group_id: "group-flat",
          deleted_at: null,
        },
      ],
    },
    {
      entity: "tally.obligation",
      primaryKey: "obligation_id",
      seatColumns: [
        "obligation_id",
        "from_party",
        "to_party",
        "amount_minor",
        "currency",
        "reason",
        "incurred_on",
        "settled_at",
        "deleted_at",
      ],
      columns: [
        "obligation_id",
        "from_party",
        "to_party",
        "amount_minor",
        "currency",
        "settled_at",
        "deleted_at",
      ],
      rows: [
        {
          obligation_id: "obligation-1",
          from_party: "party-bo",
          to_party: OWNER,
          amount_minor: 2500,
          currency: "GBP",
          settled_at: null,
          deleted_at: null,
        },
      ],
    },
    {
      entity: "tally.nudge",
      primaryKey: "nudge_id",
      seatColumns: [
        "nudge_id",
        "party_id",
        "group_id",
        "as_of_minor",
        "note",
        "prepared_at",
        "created_at",
      ],
      columns: [
        "nudge_id",
        "party_id",
        "group_id",
        "as_of_minor",
        "note",
        "prepared_at",
      ],
      rows: [
        {
          nudge_id: "nudge-1",
          party_id: "party-cy",
          group_id: "group-flat",
          as_of_minor: 1500,
          note: "Rent",
          prepared_at: "2026-05-05T09:00:00.000Z",
        },
      ],
    },
    {
      entity: "tally.recurring_expense",
      primaryKey: "template_id",
      seatColumns: [
        "template_id",
        "group_id",
        "description",
        "original_amount_minor",
        "original_currency",
        "settlement_currency",
        "paid_by",
        "category",
        "rrule",
        "anchor_start",
        "tz",
        "rate_scaled",
        "rate_scale",
        "rate_source",
        "rate_date",
        "status",
        "last_materialized_start",
        "updated_at",
      ],
      columns: [
        "template_id",
        "group_id",
        "description",
        "original_amount_minor",
        "original_currency",
        "settlement_currency",
        "rrule",
        "anchor_start",
        "tz",
        "status",
        "updated_at",
      ],
      rows: [
        {
          template_id: "template-1",
          group_id: "group-flat",
          description: "Broadband",
          original_amount_minor: 4000,
          original_currency: "GBP",
          settlement_currency: "GBP",
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
          anchor_start: "2026-01-01T09:00:00.000Z",
          tz: "Europe/London",
          status: "active",
          updated_at: "2026-01-01T09:00:00.000Z",
        },
      ],
    },
    {
      entity: "schedule.recurrence_exception",
      primaryKey: "exception_id",
      seatColumns: [
        "exception_id",
        "target_type",
        "target_id",
        "original_start_local",
        "recurrence_semantics",
        "scope",
        "action",
        "override_json",
      ],
      columns: [
        "exception_id",
        "target_type",
        "target_id",
        "original_start_local",
        "action",
        "scope",
        "override_json",
      ],
      rows: [
        {
          exception_id: "exception-1",
          target_type: "tally.recurring_expense",
          target_id: "template-1",
          original_start_local: "2026-02-01T09:00:00.000Z",
          action: "skip",
          scope: "occurrence",
          override_json: null,
        },
      ],
    },
    {
      entity: "core.attachment",
      primaryKey: "attachment_id",
      seatColumns: [
        "attachment_id",
        "target_type",
        "target_id",
        "content_id",
        "role",
        "is_primary",
      ],
      columns: [
        "attachment_id",
        "target_type",
        "target_id",
        "role",
        "content_id",
      ],
      rows: [],
    },
    {
      entity: "tally.expense_line_item",
      primaryKey: "line_item_id",
      columns: [
        "line_item_id",
        "expense_id",
        "receipt_id",
        "kind",
        "description",
        "amount_minor",
        "sort_order",
      ],
      rows: [],
    },
    {
      entity: "tally.expense_line_allocation",
      primaryKey: "allocation_id",
      columns: ["allocation_id", "line_item_id", "party_id", "share_minor"],
      rows: [],
    },
    {
      entity: "core.content_item",
      primaryKey: "content_id",
      seatColumns: ["content_id", "content_uri", "media_type", "byte_size"],
      columns: ["content_id", "content_uri", "media_type"],
      rows: [],
    },
  ];
}

/** Tables the ledger's handlers read past their own rows into. */
const TALLY_DECORATION_TABLES = [
  {
    table: "core_entity_revision",
    columns: [
      "revision_id",
      "entity_type",
      "entity_id",
      "revision_no",
      "created_at",
      "actor_party_id",
      "summary",
    ],
  },
] as const;

/**
 * The same ledger, in the tables a handler's SQL names (#996 wave 5).
 *
 * The old store's one blob table had no callers left once the airplane and
 * parity oracles moved, so it is gone; what a fixture writes is the vault's
 * own tables, which is what `ctx.vault.page` reads. The tables the dashboard only
 * DECORATES from — revisions, the attachment's bytes — are created empty: on a
 * real seat they exist and answer nothing.
 */
export function seedSeatScope(file: string): void {
  seedSeatTables(file, seedEntities(), TALLY_DECORATION_TABLES);
}

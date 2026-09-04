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
import { DatabaseSync } from "node:sqlite";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";

import { NodeSqliteDriver } from "./node-sqlite-driver";

export const VAULT_ID = "personal";
export const SHAPE_ID = "tally-default";
export const OWNER = "party-owner";
export const FRIENDS = ["party-ana", "party-bo", "party-cy"] as const;

export interface SeedEntity {
  entity: string;
  primaryKey: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

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
      columns: ["party_id"],
      rows: FRIENDS.map((party_id) => ({ party_id })),
    },
    {
      entity: "tally.group",
      primaryKey: "group_id",
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
      columns: [
        "template_id",
        "group_id",
        "description",
        "original_amount_minor",
        "original_currency",
        "settlement_currency",
        "rrule",
        "anchor_start",
        "time_zone",
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
          time_zone: "Europe/London",
          status: "active",
          updated_at: "2026-01-01T09:00:00.000Z",
        },
      ],
    },
    {
      entity: "schedule.recurrence_exception",
      primaryKey: "exception_id",
      columns: [
        "exception_id",
        "target_type",
        "target_id",
        "original_start",
        "action",
        "scope",
        "override_json",
      ],
      rows: [
        {
          exception_id: "exception-1",
          target_type: "tally.recurring_expense",
          target_id: "template-1",
          original_start: "2026-02-01T09:00:00.000Z",
          action: "skip",
          scope: "occurrence",
          override_json: null,
        },
      ],
    },
    {
      entity: "core.attachment",
      primaryKey: "attachment_id",
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
      columns: ["content_id", "content_uri", "media_type"],
      rows: [],
    },
  ];
}

export function seedScope(file: string): void {
  const entities = seedEntities();
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), VAULT_ID);
  store.bootstrap({
    protocolVersion: 1,
    vaultId: VAULT_ID,
    schemaEpoch: "1",
    cursor: { epoch: "epoch-1", seq: 1 },
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: "tally",
        purpose: "dpv:ServiceProvision",
        entities: entities.map((entity) => ({
          entity: entity.entity,
          primaryKey: entity.primaryKey,
          columns: [...entity.columns],
        })),
      },
    ],
    rows: [],
  });
  store.close();

  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES (?, ?, ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (const entity of entities)
    for (const row of entity.rows)
      insert.run(
        SHAPE_ID,
        entity.entity,
        String(row[entity.primaryKey]),
        JSON.stringify(row)
      );
  database.exec("COMMIT");
  database.close();
}

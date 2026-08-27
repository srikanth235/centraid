// governance: allow-repo-hygiene file-size-limit the second half of Tally's write surface — receipt re-allocation, group life (leave / archive / simplification opt-in) and prepared reminders — registered as one unit with tally.ts and read wholesale beside it.
// Tally's group-life and re-allocation commands. No balance is stored or
// transmitted — `simplify_opt_in` is a FLAG and the minimal-transfer set is
// derived at read time. Nothing is ever sent: `tally.nudge` records a PREPARED
// reminder under `confirm: true`, and Tally has no delivery path at all.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition } from "../gateway/types.js";
import { recordEntityRevision } from "./entity-revisions.js";
import type { LineInput, SplitInput } from "./tally-splits.js";
import {
  LINE_ITEM_SCHEMA,
  SPLIT_SCHEMA,
  expenseGroupId,
  expenseLineSnapshot,
  participantScope,
  tallyOwnerPartyId,
  writeLineItems,
  writeSplits,
} from "./tally-splits.js";

const GROUP_EXISTS_SQL =
  "SELECT count(*) AS n FROM tally_group WHERE group_id = :group_id";
const EXPENSE_LIVE_SQL =
  "SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id AND deleted_at IS NULL";

/** Lines AND derived splits in ONE invocation: apart, a receipt whose lines
 *  were re-cut but whose splits were not no longer reconciles. Both totals are
 *  re-validated; the amount never changes here. */
const REALLOCATE_RECEIPT: CommandDefinition = {
  name: "tally.reallocate_receipt",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["expense_id", "line_items", "splits"],
    additionalProperties: false,
    properties: {
      expense_id: { type: "string", minLength: 1 },
      line_items: LINE_ITEM_SCHEMA,
      splits: SPLIT_SCHEMA,
    },
  },
  outputSchema: {
    type: "object",
    required: ["expense_id", "revision_id", "undo_until"],
    properties: {
      expense_id: { type: "string" },
      revision_id: { type: "string" },
      undo_until: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "expense_live",
      sql: EXPENSE_LIVE_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      expense_id: string;
      line_items: LineInput[];
      splits: SplitInput[];
    };
    const row = ctx.db
      .prepare(
        `SELECT e.amount_minor,
                (SELECT r.receipt_id FROM tally_expense_receipt r
                  WHERE r.expense_id = e.expense_id) AS receipt_id
           FROM tally_expense e WHERE e.expense_id = ?`
      )
      .get(input.expense_id) as
      | { amount_minor: number; receipt_id: string | null }
      | undefined;
    if (!row) throw new Error("expense not found");
    const groupId = expenseGroupId(ctx, input.expense_id);
    const allowed = participantScope(ctx, groupId);
    // The pre-image carries the lines, so one undo puts back both halves.
    const revision = recordEntityRevision(ctx, {
      entityType: "tally.expense",
      entityId: input.expense_id,
      operation: "reallocate",
      snapshot: {
        expense: ctx.db
          .prepare(
            `SELECT description, amount_minor, paid_by, split_method,
                    split_params_json, spent_on, category,
                    original_amount_minor, original_currency,
                    settlement_currency, rate_scaled, rate_scale, rate_source,
                    rate_date, deleted_at, purge_at
               FROM tally_expense WHERE expense_id = ?`
          )
          .get(input.expense_id),
        splits: ctx.db
          .prepare(
            `SELECT party_id, share_minor FROM tally_expense_split
              WHERE expense_id = ? ORDER BY party_id`
          )
          .all(input.expense_id),
        payers: ctx.db
          .prepare(
            `SELECT party_id, paid_minor FROM tally_expense_payer
              WHERE expense_id = ? ORDER BY party_id`
          )
          .all(input.expense_id),
        lines: expenseLineSnapshot(ctx, input.expense_id),
      },
    });
    writeLineItems(
      ctx,
      input.expense_id,
      row.receipt_id,
      groupId,
      row.amount_minor,
      input.line_items,
      allowed
    );
    writeSplits(
      ctx,
      input.expense_id,
      groupId,
      row.amount_minor,
      input.splits,
      allowed
    );
    ctx.wrote("tally.expense", input.expense_id);
    ctx.cite({
      claim: `Re-allocated ${input.line_items.length} lines and their shares`,
      entityType: "tally.expense",
      entityId: input.expense_id,
    });
    return {
      expense_id: input.expense_id,
      revision_id: revision.revisionId,
      undo_until: revision.undoUntil,
    };
  },
};

/** Off by default, PER GROUP: simplification rewires who owes whom. The flag
 *  is the only thing written. */
const SET_GROUP_SIMPLIFICATION: CommandDefinition = {
  name: "tally.set_group_simplification",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id", "simplify"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      simplify: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["group_id", "simplify_opt_in"],
    properties: {
      group_id: { type: "string" },
      simplify_opt_in: { type: "boolean" },
    },
  },
  preconditions: [
    {
      name: "group_exists",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; simplify: boolean };
    const on = input.simplify ? 1 : 0;
    ctx.db
      .prepare("UPDATE tally_group SET simplify_opt_in = ? WHERE group_id = ?")
      .run(on, input.group_id);
    ctx.wrote("tally.group", input.group_id);
    ctx.cite({
      claim: input.simplify
        ? "Simplification turned on for this group"
        : "Simplification turned off for this group",
      entityType: "tally.group",
      entityId: input.group_id,
    });
    return { group_id: input.group_id, simplify_opt_in: input.simplify };
  },
};

/** Leaving is the case where `remove_group_member`'s refusal is wrong: rows
 *  stay put, the leaver stops being a current member, and "departed" is
 *  DERIVED, not a column. `party_id` defaults to the owner. */
const LEAVE_GROUP: CommandDefinition = {
  name: "tally.leave_group",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["group_id", "party_id"],
    properties: {
      group_id: { type: "string" },
      party_id: { type: "string" },
      on_ledger: { type: "boolean" },
    },
  },
  preconditions: [
    {
      name: "group_exists",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; party_id?: string };
    const partyId = input.party_id ?? tallyOwnerPartyId(ctx);
    const circle = ctx.db
      .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
      .get(input.group_id) as { circle_id: string } | undefined;
    if (!circle) throw new Error("group not found");
    const present = ctx.db
      .prepare(
        "SELECT 1 AS x FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
      )
      .get(circle.circle_id, partyId);
    if (!present) throw new Error("that person is not a member of this group");
    const onLedger =
      (
        ctx.db
          .prepare(
            `SELECT (
               (SELECT count(*) FROM tally_expense e
                 WHERE e.group_id = ? AND e.paid_by = ?)
               + (SELECT count(*) FROM tally_expense_split s
                    JOIN tally_expense e ON e.expense_id = s.expense_id
                   WHERE e.group_id = ? AND s.party_id = ?)
             ) AS n`
          )
          .get(input.group_id, partyId, input.group_id, partyId) as {
          n: number;
        }
      ).n > 0;
    ctx.db
      .prepare(
        "DELETE FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
      )
      .run(circle.circle_id, partyId);
    ctx.wrote("tally.group", input.group_id);
    ctx.wrote("social.circle", circle.circle_id);
    ctx.cite({
      claim: "Left the group; the ledger rows stay, marked departed",
      entityType: "tally.group",
      entityId: input.group_id,
    });
    return { group_id: input.group_id, party_id: partyId, on_ledger: onLedger };
  },
};

/** Archive is not delete, and deliberately does NOT require a settled balance
 *  — that is exactly the state you most want out of the way without losing. */
const ARCHIVE_GROUP: CommandDefinition = {
  name: "tally.archive_group",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      // Absent means archive; `false` un-archives, so one command owns both.
      archived: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["group_id"],
    properties: {
      group_id: { type: "string" },
      archived_at: { type: ["string", "null"] },
    },
  },
  preconditions: [
    {
      name: "group_exists",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; archived?: boolean };
    const archivedAt = input.archived === false ? null : ctx.now;
    ctx.db
      .prepare("UPDATE tally_group SET archived_at = ? WHERE group_id = ?")
      .run(archivedAt, input.group_id);
    ctx.wrote("tally.group", input.group_id);
    ctx.cite({
      claim: archivedAt
        ? "Group archived; it leaves the lists and keeps everything"
        : "Group restored to the lists",
      entityType: "tally.group",
      entityId: input.group_id,
    });
    return { group_id: input.group_id, archived_at: archivedAt };
  },
};

/** THE APP NEVER FIRES ONE. `confirm: true` parks every non-owner caller and
 *  an app handler is by definition one, so a nudge lands in Waiting; executing
 *  it writes ONE row saying a reminder was prepared. No delivery path exists. */
const NUDGE: CommandDefinition = {
  name: "tally.nudge",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["party_id", "as_of_minor"],
    additionalProperties: false,
    properties: {
      party_id: { type: "string", minLength: 1 },
      group_id: { type: "string", minLength: 1 },
      as_of_minor: { type: "integer" },
      note: { type: "string", maxLength: 500 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["nudge_id", "prepared_at"],
    properties: {
      nudge_id: { type: "string" },
      prepared_at: { type: "string" },
      sent: { type: "boolean" },
    },
  },
  preconditions: [
    {
      name: "person_known",
      sql: "SELECT count(*) AS n FROM core_party WHERE party_id = :party_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "nudge_recorded",
      sql: "SELECT count(*) AS n FROM tally_nudge WHERE nudge_id = :nudge_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as {
      party_id: string;
      group_id?: string;
      as_of_minor: number;
      note?: string;
    };
    const nudgeId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_nudge
          (nudge_id, party_id, group_id, as_of_minor, note, prepared_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nudgeId,
        input.party_id,
        input.group_id ?? null,
        Math.round(input.as_of_minor),
        input.note ?? null,
        ctx.now,
        ctx.now
      );
    ctx.wrote("tally.nudge", nudgeId);
    ctx.cite({
      claim: "Reminder prepared — nothing was sent",
      entityType: "tally.nudge",
      entityId: nudgeId,
    });
    // `sent` is stated, and always false, so no reader has to infer it.
    return { nudge_id: nudgeId, prepared_at: ctx.now, sent: false };
  },
};

export function registerTallyLedgerCommands(gateway: Gateway): void {
  gateway.registerCommand(REALLOCATE_RECEIPT);
  gateway.registerCommand(SET_GROUP_SIMPLIFICATION);
  gateway.registerCommand(LEAVE_GROUP);
  gateway.registerCommand(ARCHIVE_GROUP);
  gateway.registerCommand(NUDGE);
}

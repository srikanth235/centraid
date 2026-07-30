// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); Tally owns the whole expense-splitting write surface — friends, groups, membership, expenses with resolved splits, and settlements — so it is one file by design.
// Tally commands (schema `tally`): the expense-splitting write surface. A
// friend is a canonical core.party (kind='person') plus a tally_friend row
// for the avatar hue; the owner is the implicit `me` and never a friend. A
// group is an AUDIENCE (issue #310 S4): a social.circle carrying the name
// and the membership, decorated by a tally_group row with the emoji icon +
// colour (owner always a member). An expense stores its
// resolved splits (one tally_expense_split per participant) — the command
// re-validates server-side that the shares sum to the amount and that every
// participant and the payer are group members, so a projection can't smuggle
// an unbalanced or out-of-group split past the vault. A settlement is a real
// cash payment that pays balances down; balances themselves are never stored.
//
// Every write is a typed command, consent-checked and receipted, all risk low
// (money is recorded, not moved). Deleting a group is refused while it still
// holds expenses; removing a member is refused while they are on the ledger.
//
// The finance bridge (issue #310 S1): Tally is a lens over shared money, not
// a second ledger. A settlement the owner is party to IS the owner's money
// moving, so settle_up emits a core_transaction on the auto-provisioned
// "Tally settlements" cash account (external_id `tally:settlement:<id>` keeps
// replays idempotent) and stamps the settlement's txn_id. Third-party
// settlements (friend pays friend) touch no owner account and stay tally-only
// ground facts. When the bank already imported the movement, tally.bind_txn
// adopts the existing canonical row instead — the Studio paid_txn_id pattern:
// bind, don't duplicate.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import { replaceMemo } from "./annotations.js";
import { writeExtractedText } from "./enrich.js";
import {
  loadEntityRevision,
  markEntityRevisionUndone,
  recordEntityRevision,
} from "./entity-revisions.js";
import {
  convertCurrencyMinor,
  registerTallyOrganizeCommands,
} from "./tally-organize.js";

/** The vault owner's party id — Tally's implicit `me`. */
function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

/**
 * Group membership lives on the group's circle (issue #310 S4) — one
 * audience mechanism, social_circle_member, not a per-domain junction.
 */
function groupMemberIds(ctx: HandlerCtx, groupId: string): Set<string> {
  const rows = ctx.db
    .prepare(
      `SELECT m.party_id FROM social_circle_member m
         JOIN tally_group g ON g.circle_id = m.circle_id
        WHERE g.group_id = ?`
    )
    .all(groupId) as { party_id: string }[];
  return new Set(rows.map((r) => r.party_id));
}

/** The circle a group decorates. */
function circleOf(ctx: HandlerCtx, groupId: string): string {
  const row = ctx.db
    .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
    .get(groupId) as { circle_id: string } | undefined;
  if (!row) throw new Error("group not found");
  return row.circle_id;
}

/** Add one party to a circle, idempotently. Membership is a WRITE — it is
 * provenance-stamped (and demo-registered) like any other row. */
function addCircleMember(
  ctx: HandlerCtx,
  circleId: string,
  partyId: string
): void {
  const present = ctx.db
    .prepare(
      "SELECT 1 AS x FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
    )
    .get(circleId, partyId);
  if (present) return;
  const memberId = ctx.newId();
  ctx.db
    .prepare(
      "INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at) VALUES (?, ?, ?, ?)"
    )
    .run(memberId, circleId, partyId, ctx.now);
  ctx.wrote("social.circle_member", memberId);
}

const GROUP_EXISTS_SQL =
  "SELECT count(*) AS n FROM tally_group WHERE group_id = :group_id";
const EXPENSE_EXISTS_SQL =
  "SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id";
// A live expense is one not in the trash — the guard for edit/memo/trash so you
// cannot mutate or re-trash a row already on its way out (issue #441 A4).
const EXPENSE_LIVE_SQL =
  "SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id AND deleted_at IS NULL";
const EXPENSE_TRASHED_SQL =
  "SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id AND deleted_at IS NOT NULL";
const EXPENSE_ANY_SQL =
  "SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id";

interface ExpenseSnapshot {
  expense: {
    description: string;
    amount_minor: number;
    paid_by: string;
    spent_on: string;
    category: string;
    original_amount_minor: number | null;
    original_currency: string | null;
    settlement_currency: string | null;
    rate_scaled: number | null;
    rate_scale: number | null;
    rate_source: string | null;
    rate_date: string | null;
    deleted_at: string | null;
    purge_at: string | null;
  };
  splits: Array<{ party_id: string; share_minor: number }>;
}

function expenseSnapshot(ctx: HandlerCtx, expenseId: string): ExpenseSnapshot {
  const expense = ctx.db
    .prepare(
      `SELECT description, amount_minor, paid_by, spent_on, category,
              original_amount_minor, original_currency, settlement_currency,
              rate_scaled, rate_scale, rate_source, rate_date,
              deleted_at, purge_at
         FROM tally_expense WHERE expense_id = ?`
    )
    .get(expenseId) as ExpenseSnapshot["expense"] | undefined;
  if (!expense) throw new Error("expense not found");
  const splits = ctx.db
    .prepare(
      `SELECT party_id, share_minor
         FROM tally_expense_split
        WHERE expense_id = ?
        ORDER BY party_id`
    )
    .all(expenseId) as ExpenseSnapshot["splits"];
  return { expense, splits };
}

function recordExpenseRevision(
  ctx: HandlerCtx,
  expenseId: string,
  operation: string
): { revisionId: string; undoUntil: string } {
  return recordEntityRevision(ctx, {
    entityType: "tally.expense",
    entityId: expenseId,
    operation,
    snapshot: expenseSnapshot(ctx, expenseId),
  });
}

function restoreExpenseSnapshot(
  ctx: HandlerCtx,
  expenseId: string,
  snapshot: ExpenseSnapshot
): void {
  const expense = snapshot.expense;
  ctx.db
    .prepare(
      `UPDATE tally_expense
          SET description = ?, amount_minor = ?, paid_by = ?, spent_on = ?,
              category = ?, original_amount_minor = ?, original_currency = ?,
              settlement_currency = ?, rate_scaled = ?, rate_scale = ?,
              rate_source = ?, rate_date = ?, deleted_at = ?, purge_at = ?
        WHERE expense_id = ?`
    )
    .run(
      expense.description,
      expense.amount_minor,
      expense.paid_by,
      expense.spent_on,
      expense.category,
      expense.original_amount_minor,
      expense.original_currency,
      expense.settlement_currency,
      expense.rate_scaled,
      expense.rate_scale,
      expense.rate_source,
      expense.rate_date,
      expense.deleted_at,
      expense.purge_at,
      expenseId
    );
  ctx.db
    .prepare("DELETE FROM tally_expense_split WHERE expense_id = ?")
    .run(expenseId);
  const insert = ctx.db.prepare(
    `INSERT INTO tally_expense_split
      (expense_id, party_id, share_minor)
     VALUES (?, ?, ?)`
  );
  for (const split of snapshot.splits)
    insert.run(expenseId, split.party_id, split.share_minor);
  ctx.wrote("tally.expense", expenseId);
}

/** ~30-day trash grace window before the sweep purges — mirrors Docs/Locker. */
const PURGE_WINDOW_DAYS = 30;
function plusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** The vault's base currency — settlements are recorded in it. */
function baseCurrency(ctx: HandlerCtx): string {
  const row = ctx.db
    .prepare("SELECT base_currency FROM core_vault LIMIT 1")
    .get() as { base_currency: string } | undefined;
  return row?.base_currency ?? "USD";
}

/**
 * Find-or-create the owner's "Tally settlements" cash account — the canonical
 * pool settle_up's emitted transactions post against. One per vault, minted
 * lazily on the first owner-party settlement.
 */
function settlementAccountId(ctx: HandlerCtx, ownerId: string): string {
  const existing = ctx.db
    .prepare(
      `SELECT account_id FROM core_account WHERE owner_party_id = ? AND name = 'Tally settlements'`
    )
    .get(ownerId) as { account_id: string } | undefined;
  if (existing) return existing.account_id;
  const accountId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, institution_party_id, external_ref, is_asset, opened_at, closed_at)
       VALUES (?, ?, 'Tally settlements', 'cash', ?, NULL, NULL, 1, NULL, NULL)`
    )
    .run(accountId, ownerId, baseCurrency(ctx));
  ctx.wrote("core.account", accountId);
  return accountId;
}

interface SplitInput {
  party_id: string;
  share_minor: number;
}

/** Validate + write an expense's split rows; throws on any imbalance. */
function writeSplits(
  ctx: HandlerCtx,
  expenseId: string,
  groupId: string,
  amountMinor: number,
  paidBy: string,
  splits: SplitInput[]
): void {
  const members = groupMemberIds(ctx, groupId);
  if (!members.has(paidBy))
    throw new Error("payer is not a member of this group");
  if (splits.length === 0)
    throw new Error("an expense needs at least one participant");
  let sum = 0;
  const seen = new Set<string>();
  for (const s of splits) {
    const pid = String(s.party_id);
    const share = Math.round(Number(s.share_minor));
    if (!members.has(pid))
      throw new Error("a split participant is not a member of this group");
    if (seen.has(pid)) throw new Error("duplicate participant in splits");
    if (!Number.isFinite(share) || share < 0)
      throw new Error("split share must be a non-negative integer");
    seen.add(pid);
    sum += share;
  }
  if (sum !== amountMinor)
    throw new Error(
      `splits must sum to the amount (got ${sum}, need ${amountMinor})`
    );
  ctx.db
    .prepare("DELETE FROM tally_expense_split WHERE expense_id = ?")
    .run(expenseId);
  for (const s of splits) {
    ctx.db
      .prepare(
        "INSERT INTO tally_expense_split (expense_id, party_id, share_minor) VALUES (?, ?, ?)"
      )
      .run(expenseId, String(s.party_id), Math.round(Number(s.share_minor)));
  }
}

const SPLIT_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["party_id", "share_minor"],
    additionalProperties: false,
    properties: {
      party_id: { type: "string", minLength: 1 },
      share_minor: { type: "integer", minimum: 0 },
    },
  },
};

const LINE_ALLOCATION_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["party_id", "share_minor"],
    additionalProperties: false,
    properties: {
      party_id: { type: "string", minLength: 1 },
      share_minor: { type: "integer", minimum: 0 },
    },
  },
};

const RECEIPT_LINE_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    required: ["kind", "description", "amount_minor", "allocations"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["item", "tax", "tip"] },
      description: { type: "string", minLength: 1, maxLength: 500 },
      amount_minor: { type: "integer", minimum: 0 },
      allocations: LINE_ALLOCATION_SCHEMA,
    },
  },
};

const CATEGORY_ENUM = [
  "food",
  "groceries",
  "rent",
  "utilities",
  "transport",
  "fun",
  "travel",
  "shopping",
  "general",
];

const ADD_FRIEND: CommandDefinition = {
  name: "tally.add_friend",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["party_id"],
    properties: { party_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "friend_created",
      sql: "SELECT count(*) AS n FROM tally_friend WHERE party_id = :party_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    // The avatar hue is no longer stored on the friend row (issue #441 A3) —
    // one hue per party, read from people_profile or derived from party_id.
    const input = ctx.input as { name: string };
    const partyId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?, ?)`
      )
      .run(partyId, input.name, ctx.now, ctx.now, ONTOLOGY_VERSION);
    ctx.wrote("core.party", partyId);
    const friendId = ctx.newId();
    ctx.db
      .prepare(
        "INSERT INTO tally_friend (friend_id, party_id, created_at) VALUES (?, ?, ?)"
      )
      .run(friendId, partyId, ctx.now);
    ctx.wrote("tally.friend", friendId);
    ctx.cite({
      claim: `"${input.name}" added to Tally`,
      entityType: "core.party",
      entityId: partyId,
    });
    return { party_id: partyId };
  },
};

const CREATE_GROUP: CommandDefinition = {
  name: "tally.create_group",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["name", "icon", "member_ids"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      icon: { type: "string", minLength: 1 },
      color: { type: "string" },
      member_ids: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
  outputSchema: {
    type: "object",
    required: ["group_id"],
    properties: { group_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "group_created",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      name: string;
      icon: string;
      color?: string;
      member_ids: string[];
    };
    const owner = ownerPartyId(ctx);
    // The group IS an audience: a social.circle carries the name and the
    // membership; tally_group decorates it with the icon and colour (issue
    // #310 S4). Circles are UNIQUE(owner, name) — a clash is a real clash.
    const clash = ctx.db
      .prepare(
        "SELECT 1 AS x FROM social_circle WHERE owner_party_id = ? AND name = ?"
      )
      .get(owner, input.name);
    if (clash) throw new Error(`a circle named "${input.name}" already exists`);
    const circleId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind) VALUES (?, ?, ?, 'custom')`
      )
      .run(circleId, owner, input.name);
    ctx.wrote("social.circle", circleId);
    const groupId = ctx.newId();
    ctx.db
      .prepare(
        "INSERT INTO tally_group (group_id, circle_id, icon, color, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(groupId, circleId, input.icon, input.color ?? "#0FA678", ctx.now);
    ctx.wrote("tally.group", groupId);
    // The owner is always a member; friends are added by party id.
    const members = new Set<string>([owner, ...input.member_ids.map(String)]);
    for (const pid of members) addCircleMember(ctx, circleId, pid);
    ctx.cite({
      claim: `Group "${input.name}" created`,
      entityType: "tally.group",
      entityId: groupId,
    });
    return { group_id: groupId };
  },
};

const RENAME_GROUP: CommandDefinition = {
  name: "tally.rename_group",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id", "name"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    properties: { group_id: { type: "string" } },
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
    const input = ctx.input as { group_id: string; name: string };
    const circleId = circleOf(ctx, input.group_id);
    ctx.db
      .prepare("UPDATE social_circle SET name = ? WHERE circle_id = ?")
      .run(input.name, circleId);
    ctx.wrote("social.circle", circleId);
    ctx.wrote("tally.group", input.group_id);
    return { group_id: input.group_id };
  },
};

const ADD_GROUP_MEMBER: CommandDefinition = {
  name: "tally.add_group_member",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id", "party_id"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    properties: { group_id: { type: "string" } },
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
  postconditions: [
    {
      name: "member_present",
      sql: `SELECT count(*) AS n FROM social_circle_member m
             JOIN tally_group g ON g.circle_id = m.circle_id
            WHERE g.group_id = :group_id AND m.party_id = :party_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; party_id: string };
    addCircleMember(ctx, circleOf(ctx, input.group_id), input.party_id);
    ctx.wrote("tally.group", input.group_id);
    return { group_id: input.group_id };
  },
};

const REMOVE_GROUP_MEMBER: CommandDefinition = {
  name: "tally.remove_group_member",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id", "party_id"],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    properties: { group_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "group_exists",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // Refuse while the party is still on the ledger (paid or owes) in-group.
      name: "member_off_ledger",
      sql: `SELECT (
              (SELECT count(*) FROM tally_expense e WHERE e.group_id = :group_id AND e.paid_by = :party_id)
              + (SELECT count(*) FROM tally_expense_split s JOIN tally_expense e ON e.expense_id = s.expense_id
                   WHERE e.group_id = :group_id AND s.party_id = :party_id)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; party_id: string };
    if (input.party_id === ownerPartyId(ctx))
      throw new Error("you cannot remove yourself from a group");
    ctx.db
      .prepare(
        "DELETE FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
      )
      .run(circleOf(ctx, input.group_id), input.party_id);
    ctx.wrote("tally.group", input.group_id);
    return { group_id: input.group_id };
  },
};

const DELETE_GROUP: CommandDefinition = {
  name: "tally.delete_group",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["group_id"],
    additionalProperties: false,
    properties: { group_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    properties: { group_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "group_exists",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "group_empty",
      sql: "SELECT count(*) AS n FROM tally_expense WHERE group_id = :group_id",
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "group_gone",
      sql: GROUP_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const groupId = String((ctx.input as { group_id: string }).group_id);
    const circleId = circleOf(ctx, groupId);
    ctx.db
      .prepare("DELETE FROM tally_settlement WHERE group_id = ?")
      .run(groupId);
    // The decoration goes first (it FKs the circle), then the circle and
    // its membership — the group owned its audience, so it leaves with it.
    ctx.db.prepare("DELETE FROM tally_group WHERE group_id = ?").run(groupId);
    ctx.db
      .prepare("DELETE FROM social_circle_member WHERE circle_id = ?")
      .run(circleId);
    ctx.db
      .prepare("DELETE FROM social_circle WHERE circle_id = ?")
      .run(circleId);
    ctx.wrote("tally.group", groupId);
    ctx.wrote("social.circle", circleId);
    return { group_id: groupId };
  },
};

const ADD_EXPENSE: CommandDefinition = {
  name: "tally.add_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: [
      "group_id",
      "description",
      "amount_minor",
      "paid_by",
      "category",
      "splits",
    ],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      amount_minor: { type: "integer", minimum: 1 },
      paid_by: { type: "string", minLength: 1 },
      spent_on: { type: "string" },
      category: { type: "string", enum: CATEGORY_ENUM },
      splits: SPLIT_SCHEMA,
      original_amount_minor: { type: "integer", minimum: 1 },
      original_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      settlement_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      rate_scaled: { type: "integer", minimum: 1 },
      rate_scale: { type: "integer", minimum: 0, maximum: 12 },
      rate_source: { type: "string", minLength: 1 },
      rate_date: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expense_id"],
    properties: { expense_id: { type: "string" } },
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
  postconditions: [
    {
      name: "expense_created",
      sql: EXPENSE_EXISTS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      group_id: string;
      description: string;
      amount_minor: number;
      paid_by: string;
      spent_on?: string;
      category: string;
      splits: SplitInput[];
      original_amount_minor?: number;
      original_currency?: string;
      settlement_currency?: string;
      rate_scaled?: number;
      rate_scale?: number;
      rate_source?: string;
      rate_date?: string;
    };
    const originalCurrency = (
      input.original_currency ?? baseCurrency(ctx)
    ).toUpperCase();
    const settlementCurrency = (
      input.settlement_currency ?? baseCurrency(ctx)
    ).toUpperCase();
    const originalAmount = input.original_amount_minor ?? input.amount_minor;
    const rateScale = input.rate_scale ?? 6;
    const rateScaled =
      input.rate_scaled ??
      (originalCurrency === settlementCurrency ? 10 ** rateScale : undefined);
    if (
      rateScaled === undefined ||
      (originalCurrency !== settlementCurrency &&
        (!input.rate_source || !input.rate_date))
    )
      throw new Error(
        "cross-currency expenses need a rate, source, and effective date"
      );
    if (
      convertCurrencyMinor(originalAmount, rateScaled, rateScale) !==
      input.amount_minor
    )
      throw new Error("settlement amount does not match the supplied rate");
    const expenseId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_expense
          (expense_id, group_id, description, amount_minor, paid_by, spent_on,
           category, created_at, original_amount_minor, original_currency,
           settlement_currency, rate_scaled, rate_scale, rate_source, rate_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        expenseId,
        input.group_id,
        input.description,
        Math.round(input.amount_minor),
        input.paid_by,
        input.spent_on ?? ctx.now.slice(0, 10),
        input.category,
        ctx.now,
        originalAmount,
        originalCurrency,
        settlementCurrency,
        rateScaled,
        rateScale,
        input.rate_source ?? "identity",
        input.rate_date ?? input.spent_on ?? ctx.now.slice(0, 10)
      );
    ctx.wrote("tally.expense", expenseId);
    writeSplits(
      ctx,
      expenseId,
      input.group_id,
      Math.round(input.amount_minor),
      input.paid_by,
      input.splits
    );
    ctx.cite({
      claim: `"${input.description}" added`,
      entityType: "tally.expense",
      entityId: expenseId,
    });
    return { expense_id: expenseId };
  },
};

const ADD_RECEIPT_EXPENSE: CommandDefinition = {
  name: "tally.add_receipt_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: [
      "group_id",
      "description",
      "amount_minor",
      "paid_by",
      "category",
      "splits",
      "staged_sha",
      "ocr_text",
      "line_items",
    ],
    additionalProperties: false,
    properties: {
      group_id: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      amount_minor: { type: "integer", minimum: 1 },
      paid_by: { type: "string", minLength: 1 },
      spent_on: { type: "string" },
      category: { type: "string", enum: CATEGORY_ENUM },
      splits: SPLIT_SCHEMA,
      original_amount_minor: { type: "integer", minimum: 1 },
      original_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      settlement_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      rate_scaled: { type: "integer", minimum: 1 },
      rate_scale: { type: "integer", minimum: 0, maximum: 12 },
      rate_source: { type: "string", minLength: 1 },
      rate_date: { type: "string", minLength: 1 },
      staged_sha: { type: "string", minLength: 64, maxLength: 64 },
      ocr_text: { type: "string", minLength: 1, maxLength: 200_000 },
      line_items: RECEIPT_LINE_SCHEMA,
    },
  },
  outputSchema: {
    type: "object",
    required: ["expense_id", "receipt_id", "content_id"],
    properties: {
      expense_id: { type: "string" },
      receipt_id: { type: "string" },
      content_id: { type: "string" },
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
  postconditions: [
    {
      name: "receipt_expense_created",
      sql: `SELECT count(*) AS n
              FROM tally_expense_receipt r
              JOIN tally_expense e ON e.expense_id = r.expense_id
             WHERE e.expense_id = :expense_id
               AND r.receipt_id = :receipt_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      group_id: string;
      description: string;
      amount_minor: number;
      paid_by: string;
      spent_on?: string;
      category: string;
      splits: SplitInput[];
      original_amount_minor?: number;
      original_currency?: string;
      settlement_currency?: string;
      rate_scaled?: number;
      rate_scale?: number;
      rate_source?: string;
      rate_date?: string;
      staged_sha: string;
      ocr_text: string;
      line_items: Array<{
        kind: "item" | "tax" | "tip";
        description: string;
        amount_minor: number;
        allocations: SplitInput[];
      }>;
    };
    const amountMinor = Math.round(input.amount_minor);
    const lineTotal = input.line_items.reduce(
      (sum, line) => sum + Math.round(line.amount_minor),
      0
    );
    if (lineTotal !== amountMinor)
      throw new Error(
        `receipt lines must sum to the expense amount (got ${lineTotal}, need ${amountMinor})`
      );
    const members = groupMemberIds(ctx, input.group_id);
    for (const line of input.line_items) {
      const allocationTotal = line.allocations.reduce(
        (sum, allocation) => sum + Math.round(allocation.share_minor),
        0
      );
      if (allocationTotal !== Math.round(line.amount_minor))
        throw new Error(
          `allocations for "${line.description}" must sum to its amount`
        );
      const seen = new Set<string>();
      for (const allocation of line.allocations) {
        if (!members.has(allocation.party_id))
          throw new Error("a line allocation is not a group member");
        if (seen.has(allocation.party_id))
          throw new Error("duplicate participant in line allocations");
        seen.add(allocation.party_id);
      }
    }

    const originalCurrency = (
      input.original_currency ?? baseCurrency(ctx)
    ).toUpperCase();
    const settlementCurrency = (
      input.settlement_currency ?? baseCurrency(ctx)
    ).toUpperCase();
    const originalAmount = input.original_amount_minor ?? amountMinor;
    const rateScale = input.rate_scale ?? 6;
    const rateScaled =
      input.rate_scaled ??
      (originalCurrency === settlementCurrency ? 10 ** rateScale : undefined);
    if (
      rateScaled === undefined ||
      (originalCurrency !== settlementCurrency &&
        (!input.rate_source || !input.rate_date))
    )
      throw new Error(
        "cross-currency expenses need a rate, source, and effective date"
      );
    if (
      convertCurrencyMinor(originalAmount, rateScaled, rateScale) !==
      amountMinor
    )
      throw new Error("settlement amount does not match the supplied rate");

    const minted = ctx.blobs.claimStaged(input.staged_sha, {
      title: `${input.description} receipt`,
    });
    const expenseId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_expense
          (expense_id, group_id, description, amount_minor, paid_by, spent_on,
           category, created_at, original_amount_minor, original_currency,
           settlement_currency, rate_scaled, rate_scale, rate_source, rate_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        expenseId,
        input.group_id,
        input.description,
        amountMinor,
        input.paid_by,
        input.spent_on ?? ctx.now.slice(0, 10),
        input.category,
        ctx.now,
        originalAmount,
        originalCurrency,
        settlementCurrency,
        rateScaled,
        rateScale,
        input.rate_source ?? "identity",
        input.rate_date ?? input.spent_on ?? ctx.now.slice(0, 10)
      );
    ctx.wrote("tally.expense", expenseId);
    writeSplits(
      ctx,
      expenseId,
      input.group_id,
      amountMinor,
      input.paid_by,
      input.splits
    );

    const receiptId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_expense_receipt
          (receipt_id, expense_id, content_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(receiptId, expenseId, minted.contentId, ctx.now);
    ctx.wrote("tally.expense_receipt", receiptId);
    ctx.wrote("core.content_item", minted.contentId);
    const attachmentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_attachment
          (attachment_id, target_type, target_id, content_id, role, is_primary,
           created_at)
         VALUES (?, 'tally.expense', ?, ?, 'receipt', 1, ?)`
      )
      .run(attachmentId, expenseId, minted.contentId, ctx.now);
    ctx.wrote("core.attachment", attachmentId);
    writeExtractedText(ctx, minted.contentId, input.ocr_text);

    const insertLine = ctx.db.prepare(
      `INSERT INTO tally_expense_line_item
        (line_item_id, receipt_id, kind, description, amount_minor, sort_order,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAllocation = ctx.db.prepare(
      `INSERT INTO tally_expense_line_allocation
        (line_item_id, party_id, share_minor, created_at)
       VALUES (?, ?, ?, ?)`
    );
    input.line_items.forEach((line, index) => {
      const lineItemId = ctx.newId();
      insertLine.run(
        lineItemId,
        receiptId,
        line.kind,
        line.description,
        Math.round(line.amount_minor),
        index,
        ctx.now
      );
      ctx.wrote("tally.expense_line_item", lineItemId);
      for (const allocation of line.allocations) {
        insertAllocation.run(
          lineItemId,
          allocation.party_id,
          Math.round(allocation.share_minor),
          ctx.now
        );
        ctx.wrote(
          "tally.expense_line_allocation",
          `${lineItemId}:${allocation.party_id}`
        );
      }
    });
    ctx.cite({
      claim: `"${input.description}" published from a reviewed receipt with ${input.line_items.length} allocated lines`,
      entityType: "tally.expense",
      entityId: expenseId,
    });
    return {
      expense_id: expenseId,
      receipt_id: receiptId,
      content_id: minted.contentId,
    };
  },
};

const EDIT_EXPENSE: CommandDefinition = {
  name: "tally.edit_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: [
      "expense_id",
      "description",
      "amount_minor",
      "paid_by",
      "category",
      "splits",
    ],
    additionalProperties: false,
    properties: {
      expense_id: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      amount_minor: { type: "integer", minimum: 1 },
      paid_by: { type: "string", minLength: 1 },
      spent_on: { type: "string" },
      category: { type: "string", enum: CATEGORY_ENUM },
      splits: SPLIT_SCHEMA,
      original_amount_minor: { type: "integer", minimum: 1 },
      original_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      settlement_currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      rate_scaled: { type: "integer", minimum: 1 },
      rate_scale: { type: "integer", minimum: 0, maximum: 12 },
      rate_source: { type: "string", minLength: 1 },
      rate_date: { type: "string", minLength: 1 },
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
      description: string;
      amount_minor: number;
      paid_by: string;
      spent_on?: string;
      category: string;
      splits: SplitInput[];
      original_amount_minor?: number;
      original_currency?: string;
      settlement_currency?: string;
      rate_scaled?: number;
      rate_scale?: number;
      rate_source?: string;
      rate_date?: string;
    };
    const existing = ctx.db
      .prepare(
        `SELECT group_id, original_amount_minor, original_currency,
                settlement_currency, rate_scaled, rate_scale, rate_source, rate_date
           FROM tally_expense WHERE expense_id = ?`
      )
      .get(input.expense_id) as
      | {
          group_id: string;
          original_amount_minor: number | null;
          original_currency: string | null;
          settlement_currency: string | null;
          rate_scaled: number | null;
          rate_scale: number | null;
          rate_source: string | null;
          rate_date: string | null;
        }
      | undefined;
    if (!existing) throw new Error("expense not found");
    // Preserve live FX provenance unless the caller supplies a rate set.
    // Previously undeclared FX keys were stripped by the schema, so every edit
    // collapsed cross-currency rows to identity base currency.
    const base = baseCurrency(ctx);
    const hasFxInput =
      input.original_amount_minor !== undefined ||
      input.original_currency !== undefined ||
      input.settlement_currency !== undefined ||
      input.rate_scaled !== undefined ||
      input.rate_scale !== undefined ||
      input.rate_source !== undefined ||
      input.rate_date !== undefined;
    let originalCurrency: string;
    let settlementCurrency: string;
    let originalAmount: number;
    let rateScale: number;
    let rateScaled: number | undefined;
    let rateSource: string | undefined;
    let rateDate: string;
    if (hasFxInput) {
      originalCurrency = (
        input.original_currency ??
        existing.original_currency ??
        base
      ).toUpperCase();
      settlementCurrency = (
        input.settlement_currency ??
        existing.settlement_currency ??
        base
      ).toUpperCase();
      originalAmount =
        input.original_amount_minor ??
        existing.original_amount_minor ??
        input.amount_minor;
      rateScale = input.rate_scale ?? existing.rate_scale ?? 6;
      rateScaled =
        input.rate_scaled ??
        existing.rate_scaled ??
        (originalCurrency === settlementCurrency ? 10 ** rateScale : undefined);
      rateSource =
        input.rate_source ??
        existing.rate_source ??
        (originalCurrency === settlementCurrency ? "identity" : undefined);
      rateDate =
        input.rate_date ??
        existing.rate_date ??
        input.spent_on ??
        ctx.now.slice(0, 10);
    } else {
      originalCurrency = (existing.original_currency ?? base).toUpperCase();
      settlementCurrency = (existing.settlement_currency ?? base).toUpperCase();
      rateScale = existing.rate_scale ?? 6;
      const existingOriginal =
        existing.original_amount_minor ?? input.amount_minor;
      const existingScaled =
        existing.rate_scaled ??
        (originalCurrency === settlementCurrency ? 10 ** rateScale : undefined);
      if (
        existingScaled !== undefined &&
        convertCurrencyMinor(existingOriginal, existingScaled, rateScale) ===
          input.amount_minor
      ) {
        // Settlement amount still matches stored FX — keep provenance.
        originalAmount = existingOriginal;
        rateScaled = existingScaled;
        rateSource =
          existing.rate_source ??
          (originalCurrency === settlementCurrency ? "identity" : undefined);
        rateDate = existing.rate_date ?? input.spent_on ?? ctx.now.slice(0, 10);
      } else if (originalCurrency === settlementCurrency) {
        // Same-currency amount change — retarget the identity rate.
        originalAmount = input.amount_minor;
        rateScaled = 10 ** rateScale;
        rateSource = "identity";
        rateDate = input.spent_on ?? ctx.now.slice(0, 10);
      } else {
        throw new Error(
          "cross-currency amount changes need a rate, source, and effective date"
        );
      }
    }
    if (
      rateScaled === undefined ||
      (originalCurrency !== settlementCurrency && !rateSource)
    )
      throw new Error(
        "cross-currency expenses need a rate, source, and effective date"
      );
    if (
      convertCurrencyMinor(originalAmount, rateScaled, rateScale) !==
      input.amount_minor
    )
      throw new Error("settlement amount does not match the supplied rate");
    const revision = recordExpenseRevision(ctx, input.expense_id, "edit");
    ctx.db
      .prepare(
        `UPDATE tally_expense
           SET description = :description, amount_minor = :amount_minor, paid_by = :paid_by,
               spent_on = COALESCE(:spent_on, spent_on), category = :category,
               original_amount_minor = :original_amount_minor,
               original_currency = :original_currency,
               settlement_currency = :settlement_currency,
               rate_scaled = :rate_scaled, rate_scale = :rate_scale,
               rate_source = :rate_source, rate_date = :rate_date
         WHERE expense_id = :expense_id`
      )
      .run({
        expense_id: input.expense_id,
        description: input.description,
        amount_minor: Math.round(input.amount_minor),
        paid_by: input.paid_by,
        spent_on: input.spent_on ?? null,
        category: input.category,
        original_amount_minor: originalAmount,
        original_currency: originalCurrency,
        settlement_currency: settlementCurrency,
        rate_scaled: rateScaled,
        rate_scale: rateScale,
        rate_source: rateSource ?? "identity",
        rate_date: rateDate,
      });
    ctx.wrote("tally.expense", input.expense_id);
    writeSplits(
      ctx,
      input.expense_id,
      existing.group_id,
      Math.round(input.amount_minor),
      input.paid_by,
      input.splits
    );
    return {
      expense_id: input.expense_id,
      revision_id: revision.revisionId,
      undo_until: revision.undoUntil,
    };
  },
};

const DELETE_EXPENSE: CommandDefinition = {
  name: "tally.delete_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["expense_id"],
    additionalProperties: false,
    properties: { expense_id: { type: "string", minLength: 1 } },
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
  postconditions: [
    {
      name: "expense_trashed",
      sql: EXPENSE_TRASHED_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    // Reversible grace-window trash (issue #441 A4), not an instant hard delete.
    // Splits stay put — the balance engine already ignores them once the expense
    // drops out of the deleted_at IS NULL window, and the sweep cascades them at
    // purge (tally_expense_split ON DELETE CASCADE) along with cleaning the
    // expense's polymorphic references (its memo annotation among them).
    const expenseId = String((ctx.input as { expense_id: string }).expense_id);
    const revision = recordExpenseRevision(ctx, expenseId, "trash");
    ctx.db
      .prepare(
        "UPDATE tally_expense SET deleted_at = :now, purge_at = :purge WHERE expense_id = :expense_id"
      )
      .run({
        expense_id: expenseId,
        now: ctx.now,
        purge: plusDays(ctx.now, PURGE_WINDOW_DAYS),
      });
    ctx.wrote("tally.expense", expenseId);
    return {
      expense_id: expenseId,
      revision_id: revision.revisionId,
      undo_until: revision.undoUntil,
    };
  },
};

const RESTORE_EXPENSE: CommandDefinition = {
  name: "tally.restore_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["expense_id"],
    additionalProperties: false,
    properties: { expense_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    properties: { expense_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "expense_trashed",
      sql: EXPENSE_TRASHED_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "expense_live",
      sql: EXPENSE_LIVE_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    // Lossless restore within the grace window — splits were never dropped.
    const expenseId = String((ctx.input as { expense_id: string }).expense_id);
    recordExpenseRevision(ctx, expenseId, "restore");
    ctx.db
      .prepare(
        "UPDATE tally_expense SET deleted_at = NULL, purge_at = NULL WHERE expense_id = :expense_id"
      )
      .run({ expense_id: expenseId });
    ctx.wrote("tally.expense", expenseId);
    return { expense_id: expenseId };
  },
};

const UNDO_EXPENSE: CommandDefinition = {
  name: "tally.undo_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["expense_id", "revision_id"],
    additionalProperties: false,
    properties: {
      expense_id: { type: "string", minLength: 1 },
      revision_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expense_id", "revision_id"],
    properties: {
      expense_id: { type: "string" },
      revision_id: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "expense_exists_including_trash",
      sql: EXPENSE_ANY_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { expense_id: string; revision_id: string };
    const revision = loadEntityRevision<ExpenseSnapshot>(ctx, {
      entityType: "tally.expense",
      entityId: input.expense_id,
      revisionId: input.revision_id,
    });
    restoreExpenseSnapshot(ctx, input.expense_id, revision.snapshot);
    markEntityRevisionUndone(ctx, revision.revisionId);
    return {
      expense_id: input.expense_id,
      revision_id: revision.revisionId,
    };
  },
};

const SETTLE_UP: CommandDefinition = {
  name: "tally.settle_up",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["from_party", "to_party", "amount_minor"],
    additionalProperties: false,
    properties: {
      from_party: { type: "string", minLength: 1 },
      to_party: { type: "string", minLength: 1 },
      amount_minor: { type: "integer", minimum: 1 },
      group_id: { type: "string", minLength: 1 },
      paid_on: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["settlement_id"],
    properties: { settlement_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "settlement_created",
      sql: "SELECT count(*) AS n FROM tally_settlement WHERE settlement_id = :settlement_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      from_party: string;
      to_party: string;
      amount_minor: number;
      group_id?: string;
      paid_on?: string;
    };
    if (input.from_party === input.to_party)
      throw new Error("a settlement needs two different people");
    if (input.group_id) {
      const g = ctx.db
        .prepare("SELECT count(*) AS n FROM tally_group WHERE group_id = ?")
        .get(input.group_id) as { n: number };
      if (g.n !== 1) throw new Error("group not found");
    }
    const settlementId = ctx.newId();
    const paidOn = input.paid_on ?? ctx.now.slice(0, 10);
    const amount = Math.round(input.amount_minor);

    // The finance bridge: when the owner is a party to the payment, their
    // money actually moved — emit the canonical transaction and bind it.
    // Friend-to-friend settlements touch no owner pool and stay tally-only.
    const meId = ownerPartyId(ctx);
    let txnId: string | null = null;
    if (input.from_party === meId || input.to_party === meId) {
      const accountId = settlementAccountId(ctx, meId);
      const ownerPays = input.from_party === meId;
      const otherId = ownerPays ? input.to_party : input.from_party;
      const other = ctx.db
        .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
        .get(otherId) as { display_name: string } | undefined;
      txnId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, transfer_group_id, counterparty_party_id, description, category_concept_id, external_id)
           VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`
        )
        .run(
          txnId,
          accountId,
          `${paidOn}T00:00:00Z`,
          amount,
          baseCurrency(ctx),
          ownerPays ? "debit" : "credit",
          otherId,
          `Tally settlement${other ? ` — ${other.display_name}` : ""}`,
          `tally:settlement:${settlementId}`
        );
      ctx.wrote("core.transaction", txnId);
    }

    ctx.db
      .prepare(
        `INSERT INTO tally_settlement (settlement_id, group_id, from_party, to_party, amount_minor, paid_on, txn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        settlementId,
        input.group_id ?? null,
        input.from_party,
        input.to_party,
        amount,
        paidOn,
        txnId,
        ctx.now
      );
    ctx.wrote("tally.settlement", settlementId);
    ctx.cite({
      claim: "Payment recorded",
      entityType: "tally.settlement",
      entityId: settlementId,
    });
    if (txnId)
      ctx.cite({
        claim: "Settlement posted to the canonical ledger",
        entityType: "core.transaction",
        entityId: txnId,
      });
    return { settlement_id: settlementId, txn_id: txnId };
  },
};

const BIND_TXN: CommandDefinition = {
  name: "tally.bind_txn",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["txn_id"],
    additionalProperties: false,
    properties: {
      txn_id: { type: "string", minLength: 1 },
      expense_id: { type: "string", minLength: 1 },
      settlement_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: { type: "object", properties: { txn_id: { type: "string" } } },
  preconditions: [
    {
      name: "txn_exists",
      sql: "SELECT count(*) AS n FROM core_transaction WHERE txn_id = :txn_id",
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
      txn_id: string;
      expense_id?: string;
      settlement_id?: string;
    };
    const targets = [input.expense_id, input.settlement_id].filter(
      Boolean
    ).length;
    if (targets !== 1)
      throw new Error("bind exactly one of expense_id or settlement_id");
    if (input.expense_id) {
      const changed = ctx.db
        .prepare("UPDATE tally_expense SET txn_id = ? WHERE expense_id = ?")
        .run(input.txn_id, input.expense_id);
      if (changed.changes !== 1) throw new Error("expense not found");
      ctx.wrote("tally.expense", input.expense_id);
    } else if (input.settlement_id) {
      const changed = ctx.db
        .prepare(
          "UPDATE tally_settlement SET txn_id = ? WHERE settlement_id = ?"
        )
        .run(input.txn_id, input.settlement_id);
      if (changed.changes !== 1) throw new Error("settlement not found");
      ctx.wrote("tally.settlement", input.settlement_id);
    }
    ctx.cite({
      claim: "Tally row bound to the canonical transaction",
      entityType: "core.transaction",
      entityId: input.txn_id,
    });
    return { txn_id: input.txn_id };
  },
};

const SET_EXPENSE_MEMO: CommandDefinition = {
  name: "tally.set_expense_memo",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["expense_id", "note"],
    additionalProperties: false,
    properties: {
      expense_id: { type: "string", minLength: 1 },
      // '' clears the memo (the one-running-memo-per-entity semantic).
      note: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    properties: { expense_id: { type: "string" } },
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
    // The owner's remark about an expense is entity-scoped meaning (issue
    // #310 C6): knowledge.annotation on the canonical row, the same memo
    // People and Social write — never a prose column.
    const input = ctx.input as { expense_id: string; note: string };
    replaceMemo(ctx, "tally.expense", input.expense_id, input.note);
    ctx.wrote("tally.expense", input.expense_id);
    return { expense_id: input.expense_id };
  },
};

/** Register the Tally commands on a gateway. */
export function registerTallyCommands(gateway: Gateway): void {
  registerTallyOrganizeCommands(gateway);
  gateway.registerCommand(ADD_FRIEND);
  gateway.registerCommand(CREATE_GROUP);
  gateway.registerCommand(RENAME_GROUP);
  gateway.registerCommand(ADD_GROUP_MEMBER);
  gateway.registerCommand(REMOVE_GROUP_MEMBER);
  gateway.registerCommand(DELETE_GROUP);
  gateway.registerCommand(ADD_EXPENSE);
  gateway.registerCommand(ADD_RECEIPT_EXPENSE);
  gateway.registerCommand(EDIT_EXPENSE);
  gateway.registerCommand(DELETE_EXPENSE);
  gateway.registerCommand(RESTORE_EXPENSE);
  gateway.registerCommand(UNDO_EXPENSE);
  gateway.registerCommand(SETTLE_UP);
  gateway.registerCommand(BIND_TXN);
  gateway.registerCommand(SET_EXPENSE_MEMO);
}

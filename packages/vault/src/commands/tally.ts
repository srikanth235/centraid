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

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { replaceMemo } from './annotations.js';

/** The vault owner's party id — Tally's implicit `me`. */
function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
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
        WHERE g.group_id = ?`,
    )
    .all(groupId) as { party_id: string }[];
  return new Set(rows.map((r) => r.party_id));
}

/** The circle a group decorates. */
function circleOf(ctx: HandlerCtx, groupId: string): string {
  const row = ctx.db
    .prepare('SELECT circle_id FROM tally_group WHERE group_id = ?')
    .get(groupId) as { circle_id: string } | undefined;
  if (!row) throw new Error('group not found');
  return row.circle_id;
}

/** Add one party to a circle, idempotently. */
function addCircleMember(ctx: HandlerCtx, circleId: string, partyId: string): void {
  const present = ctx.db
    .prepare('SELECT 1 AS x FROM social_circle_member WHERE circle_id = ? AND party_id = ?')
    .get(circleId, partyId);
  if (present) return;
  ctx.db
    .prepare(
      'INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at) VALUES (?, ?, ?, ?)',
    )
    .run(ctx.newId(), circleId, partyId, ctx.now);
}

const GROUP_EXISTS_SQL = 'SELECT count(*) AS n FROM tally_group WHERE group_id = :group_id';
const EXPENSE_EXISTS_SQL = 'SELECT count(*) AS n FROM tally_expense WHERE expense_id = :expense_id';

/** The vault's base currency — settlements are recorded in it. */
function baseCurrency(ctx: HandlerCtx): string {
  const row = ctx.db.prepare('SELECT base_currency FROM core_vault LIMIT 1').get() as
    | { base_currency: string }
    | undefined;
  return row?.base_currency ?? 'USD';
}

/**
 * Find-or-create the owner's "Tally settlements" cash account — the canonical
 * pool settle_up's emitted transactions post against. One per vault, minted
 * lazily on the first owner-party settlement.
 */
function settlementAccountId(ctx: HandlerCtx, ownerId: string): string {
  const existing = ctx.db
    .prepare(`SELECT account_id FROM core_account WHERE owner_party_id = ? AND name = 'Tally settlements'`)
    .get(ownerId) as { account_id: string } | undefined;
  if (existing) return existing.account_id;
  const accountId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, institution_party_id, external_ref, is_asset, opened_at, closed_at)
       VALUES (?, ?, 'Tally settlements', 'cash', ?, NULL, NULL, 1, NULL, NULL)`,
    )
    .run(accountId, ownerId, baseCurrency(ctx));
  ctx.wrote('core.account', accountId);
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
  splits: SplitInput[],
): void {
  const members = groupMemberIds(ctx, groupId);
  if (!members.has(paidBy)) throw new Error('payer is not a member of this group');
  if (splits.length === 0) throw new Error('an expense needs at least one participant');
  let sum = 0;
  const seen = new Set<string>();
  for (const s of splits) {
    const pid = String(s.party_id);
    const share = Math.round(Number(s.share_minor));
    if (!members.has(pid)) throw new Error('a split participant is not a member of this group');
    if (seen.has(pid)) throw new Error('duplicate participant in splits');
    if (!Number.isFinite(share) || share < 0)
      throw new Error('split share must be a non-negative integer');
    seen.add(pid);
    sum += share;
  }
  if (sum !== amountMinor)
    throw new Error(`splits must sum to the amount (got ${sum}, need ${amountMinor})`);
  ctx.db.prepare('DELETE FROM tally_expense_split WHERE expense_id = ?').run(expenseId);
  for (const s of splits) {
    ctx.db
      .prepare(
        'INSERT INTO tally_expense_split (expense_id, party_id, share_minor) VALUES (?, ?, ?)',
      )
      .run(expenseId, String(s.party_id), Math.round(Number(s.share_minor)));
  }
}

const SPLIT_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['party_id', 'share_minor'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      share_minor: { type: 'integer', minimum: 0 },
    },
  },
};

const CATEGORY_ENUM = [
  'food',
  'groceries',
  'rent',
  'utilities',
  'transport',
  'fun',
  'travel',
  'shopping',
  'general',
];

const ADD_FRIEND: CommandDefinition = {
  name: 'tally.add_friend',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      avatar_color: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'friend_created',
      sql: 'SELECT count(*) AS n FROM tally_friend WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { name: string; avatar_color?: string };
    const partyId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(partyId, input.name, ctx.now, ctx.now, ONTOLOGY_VERSION);
    ctx.wrote('core.party', partyId);
    const friendId = ctx.newId();
    ctx.db
      .prepare(
        'INSERT INTO tally_friend (friend_id, party_id, avatar_color, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(friendId, partyId, input.avatar_color ?? null, ctx.now);
    ctx.wrote('tally.friend', friendId);
    ctx.cite({
      claim: `"${input.name}" added to Tally`,
      entityType: 'core.party',
      entityId: partyId,
    });
    return { party_id: partyId };
  },
};

const CREATE_GROUP: CommandDefinition = {
  name: 'tally.create_group',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['name', 'icon', 'member_ids'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      icon: { type: 'string', minLength: 1 },
      color: { type: 'string' },
      member_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['group_id'],
    properties: { group_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    { name: 'group_created', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { name: string; icon: string; color?: string; member_ids: string[] };
    const owner = ownerPartyId(ctx);
    // The group IS an audience: a social.circle carries the name and the
    // membership; tally_group decorates it with the icon and colour (issue
    // #310 S4). Circles are UNIQUE(owner, name) — a clash is a real clash.
    const clash = ctx.db
      .prepare('SELECT 1 AS x FROM social_circle WHERE owner_party_id = ? AND name = ?')
      .get(owner, input.name);
    if (clash) throw new Error(`a circle named "${input.name}" already exists`);
    const circleId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind) VALUES (?, ?, ?, 'custom')`,
      )
      .run(circleId, owner, input.name);
    ctx.wrote('social.circle', circleId);
    const groupId = ctx.newId();
    ctx.db
      .prepare(
        'INSERT INTO tally_group (group_id, circle_id, icon, color, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(groupId, circleId, input.icon, input.color ?? '#0FA678', ctx.now);
    ctx.wrote('tally.group', groupId);
    // The owner is always a member; friends are added by party id.
    const members = new Set<string>([owner, ...input.member_ids.map(String)]);
    for (const pid of members) addCircleMember(ctx, circleId, pid);
    ctx.cite({
      claim: `Group "${input.name}" created`,
      entityType: 'tally.group',
      entityId: groupId,
    });
    return { group_id: groupId };
  },
};

const RENAME_GROUP: CommandDefinition = {
  name: 'tally.rename_group',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['group_id', 'name'],
    additionalProperties: false,
    properties: {
      group_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: { type: 'object', properties: { group_id: { type: 'string' } } },
  preconditions: [{ name: 'group_exists', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; name: string };
    const circleId = circleOf(ctx, input.group_id);
    ctx.db
      .prepare('UPDATE social_circle SET name = ? WHERE circle_id = ?')
      .run(input.name, circleId);
    ctx.wrote('social.circle', circleId);
    ctx.wrote('tally.group', input.group_id);
    return { group_id: input.group_id };
  },
};

const ADD_GROUP_MEMBER: CommandDefinition = {
  name: 'tally.add_group_member',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['group_id', 'party_id'],
    additionalProperties: false,
    properties: {
      group_id: { type: 'string', minLength: 1 },
      party_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: { type: 'object', properties: { group_id: { type: 'string' } } },
  preconditions: [{ name: 'group_exists', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [
    {
      name: 'member_present',
      sql: `SELECT count(*) AS n FROM social_circle_member m
             JOIN tally_group g ON g.circle_id = m.circle_id
            WHERE g.group_id = :group_id AND m.party_id = :party_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; party_id: string };
    addCircleMember(ctx, circleOf(ctx, input.group_id), input.party_id);
    ctx.wrote('tally.group', input.group_id);
    return { group_id: input.group_id };
  },
};

const REMOVE_GROUP_MEMBER: CommandDefinition = {
  name: 'tally.remove_group_member',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['group_id', 'party_id'],
    additionalProperties: false,
    properties: {
      group_id: { type: 'string', minLength: 1 },
      party_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: { type: 'object', properties: { group_id: { type: 'string' } } },
  preconditions: [
    { name: 'group_exists', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      // Refuse while the party is still on the ledger (paid or owes) in-group.
      name: 'member_off_ledger',
      sql: `SELECT (
              (SELECT count(*) FROM tally_expense e WHERE e.group_id = :group_id AND e.paid_by = :party_id)
              + (SELECT count(*) FROM tally_expense_split s JOIN tally_expense e ON e.expense_id = s.expense_id
                   WHERE e.group_id = :group_id AND s.party_id = :party_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { group_id: string; party_id: string };
    if (input.party_id === ownerPartyId(ctx))
      throw new Error('you cannot remove yourself from a group');
    ctx.db
      .prepare('DELETE FROM social_circle_member WHERE circle_id = ? AND party_id = ?')
      .run(circleOf(ctx, input.group_id), input.party_id);
    ctx.wrote('tally.group', input.group_id);
    return { group_id: input.group_id };
  },
};

const DELETE_GROUP: CommandDefinition = {
  name: 'tally.delete_group',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['group_id'],
    additionalProperties: false,
    properties: { group_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { group_id: { type: 'string' } } },
  preconditions: [
    { name: 'group_exists', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      name: 'group_empty',
      sql: 'SELECT count(*) AS n FROM tally_expense WHERE group_id = :group_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [{ name: 'group_gone', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 0 }],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const groupId = String((ctx.input as { group_id: string }).group_id);
    const circleId = circleOf(ctx, groupId);
    ctx.db.prepare('DELETE FROM tally_settlement WHERE group_id = ?').run(groupId);
    // The decoration goes first (it FKs the circle), then the circle and
    // its membership — the group owned its audience, so it leaves with it.
    ctx.db.prepare('DELETE FROM tally_group WHERE group_id = ?').run(groupId);
    ctx.db.prepare('DELETE FROM social_circle_member WHERE circle_id = ?').run(circleId);
    ctx.db.prepare('DELETE FROM social_circle WHERE circle_id = ?').run(circleId);
    ctx.wrote('tally.group', groupId);
    ctx.wrote('social.circle', circleId);
    return { group_id: groupId };
  },
};

const ADD_EXPENSE: CommandDefinition = {
  name: 'tally.add_expense',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['group_id', 'description', 'amount_minor', 'paid_by', 'category', 'splits'],
    additionalProperties: false,
    properties: {
      group_id: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      amount_minor: { type: 'integer', minimum: 1 },
      paid_by: { type: 'string', minLength: 1 },
      spent_on: { type: 'string' },
      category: { type: 'string', enum: CATEGORY_ENUM },
      splits: SPLIT_SCHEMA,
    },
  },
  outputSchema: {
    type: 'object',
    required: ['expense_id'],
    properties: { expense_id: { type: 'string' } },
  },
  preconditions: [{ name: 'group_exists', sql: GROUP_EXISTS_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [
    { name: 'expense_created', sql: EXPENSE_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      group_id: string;
      description: string;
      amount_minor: number;
      paid_by: string;
      spent_on?: string;
      category: string;
      splits: SplitInput[];
    };
    const expenseId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_expense (expense_id, group_id, description, amount_minor, paid_by, spent_on, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    ctx.wrote('tally.expense', expenseId);
    writeSplits(
      ctx,
      expenseId,
      input.group_id,
      Math.round(input.amount_minor),
      input.paid_by,
      input.splits,
    );
    ctx.cite({
      claim: `"${input.description}" added`,
      entityType: 'tally.expense',
      entityId: expenseId,
    });
    return { expense_id: expenseId };
  },
};

const EDIT_EXPENSE: CommandDefinition = {
  name: 'tally.edit_expense',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['expense_id', 'description', 'amount_minor', 'paid_by', 'category', 'splits'],
    additionalProperties: false,
    properties: {
      expense_id: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      amount_minor: { type: 'integer', minimum: 1 },
      paid_by: { type: 'string', minLength: 1 },
      spent_on: { type: 'string' },
      category: { type: 'string', enum: CATEGORY_ENUM },
      splits: SPLIT_SCHEMA,
    },
  },
  outputSchema: { type: 'object', properties: { expense_id: { type: 'string' } } },
  preconditions: [
    { name: 'expense_exists', sql: EXPENSE_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      expense_id: string;
      description: string;
      amount_minor: number;
      paid_by: string;
      spent_on?: string;
      category: string;
      splits: SplitInput[];
    };
    const row = ctx.db
      .prepare('SELECT group_id FROM tally_expense WHERE expense_id = ?')
      .get(input.expense_id) as { group_id: string } | undefined;
    if (!row) throw new Error('expense not found');
    ctx.db
      .prepare(
        `UPDATE tally_expense
           SET description = :description, amount_minor = :amount_minor, paid_by = :paid_by,
               spent_on = COALESCE(:spent_on, spent_on), category = :category
         WHERE expense_id = :expense_id`,
      )
      .run({
        expense_id: input.expense_id,
        description: input.description,
        amount_minor: Math.round(input.amount_minor),
        paid_by: input.paid_by,
        spent_on: input.spent_on ?? null,
        category: input.category,
      });
    ctx.wrote('tally.expense', input.expense_id);
    writeSplits(
      ctx,
      input.expense_id,
      row.group_id,
      Math.round(input.amount_minor),
      input.paid_by,
      input.splits,
    );
    return { expense_id: input.expense_id };
  },
};

const DELETE_EXPENSE: CommandDefinition = {
  name: 'tally.delete_expense',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['expense_id'],
    additionalProperties: false,
    properties: { expense_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: { type: 'object', properties: { expense_id: { type: 'string' } } },
  preconditions: [
    { name: 'expense_exists', sql: EXPENSE_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    { name: 'expense_gone', sql: EXPENSE_EXISTS_SQL, column: 'n', op: 'eq', value: 0 },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const expenseId = String((ctx.input as { expense_id: string }).expense_id);
    ctx.db.prepare('DELETE FROM tally_expense_split WHERE expense_id = ?').run(expenseId);
    ctx.db.prepare('DELETE FROM tally_expense WHERE expense_id = ?').run(expenseId);
    ctx.wrote('tally.expense', expenseId);
    return { expense_id: expenseId };
  },
};

const SETTLE_UP: CommandDefinition = {
  name: 'tally.settle_up',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['from_party', 'to_party', 'amount_minor'],
    additionalProperties: false,
    properties: {
      from_party: { type: 'string', minLength: 1 },
      to_party: { type: 'string', minLength: 1 },
      amount_minor: { type: 'integer', minimum: 1 },
      group_id: { type: 'string', minLength: 1 },
      paid_on: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['settlement_id'],
    properties: { settlement_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'settlement_created',
      sql: 'SELECT count(*) AS n FROM tally_settlement WHERE settlement_id = :settlement_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      from_party: string;
      to_party: string;
      amount_minor: number;
      group_id?: string;
      paid_on?: string;
    };
    if (input.from_party === input.to_party)
      throw new Error('a settlement needs two different people');
    if (input.group_id) {
      const g = ctx.db
        .prepare('SELECT count(*) AS n FROM tally_group WHERE group_id = ?')
        .get(input.group_id) as { n: number };
      if (g.n !== 1) throw new Error('group not found');
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
        .prepare('SELECT display_name FROM core_party WHERE party_id = ?')
        .get(otherId) as { display_name: string } | undefined;
      txnId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, transfer_group_id, counterparty_party_id, description, category_concept_id, external_id)
           VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`,
        )
        .run(
          txnId,
          accountId,
          `${paidOn}T00:00:00Z`,
          amount,
          baseCurrency(ctx),
          ownerPays ? 'debit' : 'credit',
          otherId,
          `Tally settlement${other ? ` — ${other.display_name}` : ''}`,
          `tally:settlement:${settlementId}`,
        );
      ctx.wrote('core.transaction', txnId);
    }

    ctx.db
      .prepare(
        `INSERT INTO tally_settlement (settlement_id, group_id, from_party, to_party, amount_minor, paid_on, txn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settlementId,
        input.group_id ?? null,
        input.from_party,
        input.to_party,
        amount,
        paidOn,
        txnId,
        ctx.now,
      );
    ctx.wrote('tally.settlement', settlementId);
    ctx.cite({ claim: 'Payment recorded', entityType: 'tally.settlement', entityId: settlementId });
    if (txnId)
      ctx.cite({
        claim: 'Settlement posted to the canonical ledger',
        entityType: 'core.transaction',
        entityId: txnId,
      });
    return { settlement_id: settlementId, txn_id: txnId };
  },
};

const BIND_TXN: CommandDefinition = {
  name: 'tally.bind_txn',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['txn_id'],
    additionalProperties: false,
    properties: {
      txn_id: { type: 'string', minLength: 1 },
      expense_id: { type: 'string', minLength: 1 },
      settlement_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: { type: 'object', properties: { txn_id: { type: 'string' } } },
  preconditions: [
    {
      name: 'txn_exists',
      sql: 'SELECT count(*) AS n FROM core_transaction WHERE txn_id = :txn_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { txn_id: string; expense_id?: string; settlement_id?: string };
    if (!input.expense_id === !input.settlement_id)
      throw new Error('bind exactly one of expense_id or settlement_id');
    if (input.expense_id) {
      const changed = ctx.db
        .prepare('UPDATE tally_expense SET txn_id = ? WHERE expense_id = ?')
        .run(input.txn_id, input.expense_id);
      if (changed.changes !== 1) throw new Error('expense not found');
      ctx.wrote('tally.expense', input.expense_id);
    } else if (input.settlement_id) {
      const changed = ctx.db
        .prepare('UPDATE tally_settlement SET txn_id = ? WHERE settlement_id = ?')
        .run(input.txn_id, input.settlement_id);
      if (changed.changes !== 1) throw new Error('settlement not found');
      ctx.wrote('tally.settlement', input.settlement_id);
    }
    ctx.cite({
      claim: 'Tally row bound to the canonical transaction',
      entityType: 'core.transaction',
      entityId: input.txn_id,
    });
    return { txn_id: input.txn_id };
  },
};

const SET_EXPENSE_MEMO: CommandDefinition = {
  name: 'tally.set_expense_memo',
  ownerSchema: 'tally',
  inputSchema: {
    type: 'object',
    required: ['expense_id', 'note'],
    additionalProperties: false,
    properties: {
      expense_id: { type: 'string', minLength: 1 },
      // '' clears the memo (the one-running-memo-per-entity semantic).
      note: { type: 'string' },
    },
  },
  outputSchema: { type: 'object', properties: { expense_id: { type: 'string' } } },
  preconditions: [
    { name: 'expense_exists', sql: EXPENSE_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    // The owner's remark about an expense is entity-scoped meaning (issue
    // #310 C6): knowledge.annotation on the canonical row, the same memo
    // People and Social write — never a prose column.
    const input = ctx.input as { expense_id: string; note: string };
    replaceMemo(ctx, 'tally.expense', input.expense_id, input.note);
    ctx.wrote('tally.expense', input.expense_id);
    return { expense_id: input.expense_id };
  },
};

/** Register the Tally commands on a gateway. */
export function registerTallyCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_FRIEND);
  gateway.registerCommand(CREATE_GROUP);
  gateway.registerCommand(RENAME_GROUP);
  gateway.registerCommand(ADD_GROUP_MEMBER);
  gateway.registerCommand(REMOVE_GROUP_MEMBER);
  gateway.registerCommand(DELETE_GROUP);
  gateway.registerCommand(ADD_EXPENSE);
  gateway.registerCommand(EDIT_EXPENSE);
  gateway.registerCommand(DELETE_EXPENSE);
  gateway.registerCommand(SETTLE_UP);
  gateway.registerCommand(BIND_TXN);
  gateway.registerCommand(SET_EXPENSE_MEMO);
}

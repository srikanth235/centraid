// The server-side re-validation every Tally expense write goes through. Four
// commands apply the SAME arithmetic guards, so no projection can smuggle an
// unbalanced split, an out-of-scope party, or lines that do not add up.
//
// It does NOT resolve a split: the client sends shares resolved, the vault
// re-checks totals. `split_method` / `split_params_json` are provenance, never
// a second arithmetic path.

import type { HandlerCtx } from "../gateway/types.js";

export interface SplitInput {
  party_id: string;
  share_minor: number;
}

export interface PayerInput {
  party_id: string;
  paid_minor: number;
}

export interface LineInput {
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  allocations: SplitInput[];
}

export const SPLIT_METHODS = [
  "equally",
  "exact",
  "percentages",
  "shares",
  "adjusted",
  "by_line",
] as const;

export const SPLIT_SCHEMA = {
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

export const PAYER_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    required: ["party_id", "paid_minor"],
    additionalProperties: false,
    properties: {
      party_id: { type: "string", minLength: 1 },
      paid_minor: { type: "integer", minimum: 0 },
    },
  },
};

export const SPLIT_METHOD_SCHEMA = {
  type: "string",
  enum: [...SPLIT_METHODS],
};

/** Stored verbatim under a `json_valid` CHECK, never read as arithmetic. */
export const SPLIT_PARAMS_SCHEMA = { type: "object" };

export const LINE_ITEM_SCHEMA = {
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
      allocations: SPLIT_SCHEMA,
    },
  },
};

export function tallyOwnerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

/** In a group, the group's circle (#310); group-less, the friend roster, so a
 *  1:1 cannot mint a participant nobody added. */
export function participantScope(
  ctx: HandlerCtx,
  groupId: string | null
): Set<string> {
  if (groupId) {
    const rows = ctx.db
      .prepare(
        `SELECT m.party_id FROM social_circle_member m
           JOIN tally_group g ON g.circle_id = m.circle_id
          WHERE g.group_id = ?`
      )
      .all(groupId) as { party_id: string }[];
    return new Set(rows.map((row) => row.party_id));
  }
  const friends = ctx.db.prepare("SELECT party_id FROM tally_friend").all() as {
    party_id: string;
  }[];
  return new Set([
    tallyOwnerPartyId(ctx),
    ...friends.map((row) => row.party_id),
  ]);
}

function outOfScope(groupId: string | null, what: string): Error {
  return new Error(
    groupId
      ? `a ${what} is not a member of this group`
      : `a ${what} on a group-less expense must be you or a Tally friend`
  );
}

function assertRoster(
  entries: readonly { party_id: string }[],
  allowed: ReadonlySet<string>,
  groupId: string | null,
  what: string
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const partyId = String(entry.party_id);
    if (!allowed.has(partyId)) throw outOfScope(groupId, what);
    if (seen.has(partyId)) throw new Error(`duplicate ${what}`);
    seen.add(partyId);
  }
}

function totalOf<T>(entries: readonly T[], key: string): number {
  let sum = 0;
  for (const entry of entries) {
    const value = Math.round(Number((entry as Record<string, unknown>)[key]));
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${key} must be a non-negative integer`);
    sum += value;
  }
  return sum;
}

/** `payers` absent is the degenerate single-payer case; `tally_expense_payer`
 *  is written for EVERY expense so both folds read one shape. */
export function resolvePayers(
  paidBy: string | undefined,
  amountMinor: number,
  payers: readonly PayerInput[] | undefined
): { payers: PayerInput[]; principal: string } {
  const resolved: PayerInput[] =
    payers && payers.length > 0
      ? payers.map((payer) => ({
          party_id: String(payer.party_id),
          paid_minor: Math.round(Number(payer.paid_minor)),
        }))
      : paidBy
        ? [{ party_id: String(paidBy), paid_minor: amountMinor }]
        : [];
  if (resolved.length === 0)
    throw new Error("an expense needs at least one payer");
  const total = totalOf(resolved, "paid_minor");
  if (total !== amountMinor)
    throw new Error(
      `payers must sum to the amount (got ${total}, need ${amountMinor})`
    );
  // `paid_by` must be one of them. With none, the largest contributor stands
  // in (ties keep the first supplied, so a re-send is stable).
  if (paidBy && !resolved.some((payer) => payer.party_id === paidBy))
    throw new Error("the named payer is not in the payer list");
  let largest = resolved[0]!;
  for (const payer of resolved)
    if (payer.paid_minor > largest.paid_minor) largest = payer;
  return { payers: resolved, principal: paidBy ?? largest.party_id };
}

/**
 * The expense's receipt: the `role='receipt'` attachment (#883). Deterministic
 * on the id, because nothing stops a member attaching two receipt photos.
 */
export const RECEIPT_ATTACHMENT_SQL = `SELECT a.attachment_id
       FROM core_attachment a
      WHERE a.target_type = 'tally.expense' AND a.target_id = e.expense_id
        AND a.role = 'receipt'
      ORDER BY a.attachment_id LIMIT 1`;

export function writePayers(
  ctx: HandlerCtx,
  expenseId: string,
  groupId: string | null,
  payers: readonly PayerInput[],
  allowed: ReadonlySet<string>
): void {
  assertRoster(payers, allowed, groupId, "payer");
  ctx.db
    .prepare("DELETE FROM tally_expense_payer WHERE expense_id = ?")
    .run(expenseId);
  const insert = ctx.db.prepare(
    "INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor) VALUES (?, ?, ?)"
  );
  // Not `ctx.wrote()` — payer rows cascade with the expense; a composite
  // `<expense>:<party>` key stamped as an entity id is a row the seed registry
  // can never address again.
  for (const payer of payers)
    insert.run(expenseId, payer.party_id, payer.paid_minor);
}

export function writeSplits(
  ctx: HandlerCtx,
  expenseId: string,
  groupId: string | null,
  amountMinor: number,
  splits: readonly SplitInput[],
  allowed: ReadonlySet<string>
): void {
  if (splits.length === 0)
    throw new Error("an expense needs at least one participant");
  assertRoster(splits, allowed, groupId, "split participant");
  const sum = totalOf(splits, "share_minor");
  if (sum !== amountMinor)
    throw new Error(
      `splits must sum to the amount (got ${sum}, need ${amountMinor})`
    );
  ctx.db
    .prepare("DELETE FROM tally_expense_split WHERE expense_id = ?")
    .run(expenseId);
  const insert = ctx.db.prepare(
    "INSERT INTO tally_expense_split (expense_id, party_id, share_minor) VALUES (?, ?, ?)"
  );
  for (const split of splits)
    insert.run(
      expenseId,
      String(split.party_id),
      Math.round(Number(split.share_minor))
    );
}

/** Replaces the whole line set. Both totals are re-checked — lines sum to the
 *  expense, allocations sum to their line — or the reconciliation is a lie. */
export function writeLineItems(
  ctx: HandlerCtx,
  expenseId: string,
  receiptId: string | null,
  groupId: string | null,
  amountMinor: number,
  lines: readonly LineInput[],
  allowed: ReadonlySet<string>
): void {
  const lineTotal = totalOf(lines, "amount_minor");
  if (lineTotal !== amountMinor)
    throw new Error(
      `lines must sum to the expense amount (got ${lineTotal}, need ${amountMinor})`
    );
  for (const line of lines) {
    const allocated = totalOf(line.allocations, "share_minor");
    if (allocated !== Math.round(Number(line.amount_minor)))
      throw new Error(
        `allocations for "${line.description}" must sum to its amount`
      );
    assertRoster(line.allocations, allowed, groupId, "line allocation");
  }
  // Allocations cascade with their line, so deleting the lines clears both.
  ctx.db
    .prepare("DELETE FROM tally_expense_line_item WHERE expense_id = ?")
    .run(expenseId);
  const insertLine = ctx.db.prepare(
    `INSERT INTO tally_expense_line_item
      (line_item_id, expense_id, receipt_id, kind, description, amount_minor,
       sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAllocation = ctx.db.prepare(
    `INSERT INTO tally_expense_line_allocation
      (line_item_id, party_id, share_minor, created_at)
     VALUES (?, ?, ?, ?)`
  );
  lines.forEach((line, index) => {
    const lineItemId = ctx.newId();
    insertLine.run(
      lineItemId,
      expenseId,
      receiptId,
      line.kind,
      line.description,
      Math.round(Number(line.amount_minor)),
      index,
      ctx.now
    );
    ctx.wrote("tally.expense_line_item", lineItemId);
    for (const allocation of line.allocations) {
      insertAllocation.run(
        lineItemId,
        String(allocation.party_id),
        Math.round(Number(allocation.share_minor)),
        ctx.now
      );
      ctx.wrote(
        "tally.expense_line_allocation",
        `${lineItemId}:${allocation.party_id}`
      );
    }
  });
}

export interface SnapshotLine {
  line_item_id: string;
  receipt_id: string | null;
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  sort_order: number;
  allocations: Array<{ party_id: string; share_minor: number }>;
}

export function expenseLineSnapshot(
  ctx: HandlerCtx,
  expenseId: string
): SnapshotLine[] {
  const lines = ctx.db
    .prepare(
      `SELECT line_item_id, receipt_id, kind, description, amount_minor, sort_order
         FROM tally_expense_line_item
        WHERE expense_id = ?
        ORDER BY sort_order`
    )
    .all(expenseId) as Array<Omit<SnapshotLine, "allocations">>;
  const allocations = ctx.db.prepare(
    `SELECT party_id, share_minor FROM tally_expense_line_allocation
      WHERE line_item_id = ? ORDER BY party_id`
  );
  return lines.map((line) => ({
    ...line,
    allocations: allocations.all(line.line_item_id) as Array<{
      party_id: string;
      share_minor: number;
    }>,
  }));
}

export function expenseGroupId(
  ctx: HandlerCtx,
  expenseId: string
): string | null {
  const row = ctx.db
    .prepare("SELECT group_id FROM tally_expense WHERE expense_id = ?")
    .get(expenseId) as { group_id: string | null } | undefined;
  if (!row) throw new Error("expense not found");
  return row.group_id;
}

export function splitParamsJson(
  params: Record<string, unknown> | undefined
): string | null {
  return params === undefined ? null : JSON.stringify(params);
}

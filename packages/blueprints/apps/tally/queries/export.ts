/**
 * BALANCES ARE EXCLUDED BY DESIGN: a balance is arithmetic over ground facts,
 * and shipping one would be the first stored balance in the app.
 *
 * The window is bounded and STATED: `truncated` and `window` travel, so a
 * partial export is never read as a whole one.
 */

import { deniedPayload, loadTally } from "./dashboard.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/** Anything not a `YYYY-MM-DD` date is no floor — a malformed bound must not
 *  narrow a ledger. */
function floorDate(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : null;
}

/** A row with NO date cannot fall inside a bounded range, so a bound excludes
 *  it. `YYYY-MM-DD` storage makes lexicographic order chronological. */
function onOrAfter(date: unknown, since: string | null): boolean {
  if (since === null) return true;
  const text = String(date ?? "").slice(0, 10);
  return text.length === 10 && text >= since;
}

interface RevisionRow {
  revision_id: string;
  entity_id: string;
  operation: string;
  recorded_at: string;
  undone_at?: string | null;
}

export default async function exportHandler({ input, ctx }: HandlerArgs) {
  const groupId = String(input?.group_id ?? "");
  const limit = Math.min(
    Math.max(Number(input?.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  const since = floorDate(input?.since);
  const emptyWindow = { limit, since, expenses: 0, settlements: 0 };
  try {
    const data = await loadTally(ctx);
    const group = data.groups.find((g) => g.group_id === groupId);
    if (!group)
      return {
        group: null,
        expenses: [],
        settlements: [],
        revisions: [],
        balances_excluded: true,
        truncated: false,
        window: emptyWindow,
      };

    // An expense ranges by the day it was SPENT, a settlement by the day it
    // was PAID; revisions follow the expenses they edited.
    const scoped = data.expenses.filter(
      (e) => e.group_id === groupId && onOrAfter(e.spent_on, since)
    );
    const settlements = data.settlements.filter(
      (s) => s.group_id === groupId && onOrAfter(s.paid_on, since)
    );
    const expenses = scoped.slice(0, limit);
    const nameOf = (partyId: string): string =>
      data.people.get(partyId)?.name ?? "Someone";

    // THE WINDOW ASKS FOR THE ROWS IT WANTS (#928). This used to read the
    // newest `MAX_LIMIT` revisions of everything and keep the ones it had
    // exported — correct only while the declared row filter narrowed the read
    // to this app's own entity type BEFORE the window was applied. The clamp
    // still refuses everything else, but a window is not a filter: name the
    // exported expenses in SQL, so the page cannot fill with rows this export
    // is about to discard.
    const exported = expenses.map((e) => e.expense_id);
    const revisionsRes =
      exported.length === 0
        ? { rows: [] }
        : await ctx.vault.read({
            entity: "core.entity_revision",
            where: [{ column: "entity_id", op: "in", value: exported }],
            orderBy: { column: "recorded_at", dir: "desc" },
            limit: MAX_LIMIT,
          });
    const revisions = (
      (revisionsRes.rows ?? []) as unknown as RevisionRow[]
    ).map((row) => ({
      revision_id: row.revision_id,
      expense_id: row.entity_id,
      operation: row.operation,
      recorded_at: row.recorded_at,
      undone_at: row.undone_at ?? null,
    }));

    return {
      group: {
        group_id: group.group_id,
        name: group.name,
        icon: group.icon,
        color: group.color,
        archived_at: group.archived_at ?? null,
        members: (data.membersByGroup.get(groupId) ?? []).map((partyId) => ({
          party_id: partyId,
          name: nameOf(partyId),
        })),
      },
      currency: data.currency,
      expenses: expenses.map((e) => ({
        expense_id: e.expense_id,
        description: e.description,
        amount_minor: e.amount_minor,
        original_amount_minor: e.original_amount_minor ?? e.amount_minor,
        original_currency: e.original_currency ?? data.currency,
        settlement_currency: e.settlement_currency ?? data.currency,
        rate_scaled: e.rate_scaled ?? null,
        rate_scale: e.rate_scale ?? null,
        rate_source: e.rate_source ?? null,
        rate_date: e.rate_date ?? null,
        category: e.category,
        spent_on: e.spent_on,
        split_method: e.split_method ?? "exact",
        paid_by: e.paid_by,
        paid_by_name: nameOf(e.paid_by),
        payers: Object.entries(e.payers).map(([partyId, paid]) => ({
          party_id: partyId,
          name: nameOf(partyId),
          paid_minor: paid,
        })),
        splits: Object.entries(e.splits).map(([partyId, share]) => ({
          party_id: partyId,
          name: nameOf(partyId),
          share_minor: share,
        })),
        line_items: e.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          amount_minor: line.amount_minor,
          allocations: Object.entries(line.allocations).map(
            ([partyId, share]) => ({
              party_id: partyId,
              name: nameOf(partyId),
              share_minor: share,
            })
          ),
        })),
        has_receipt: Boolean(e.receipt),
      })),
      settlements: settlements.slice(0, limit).map((s) => ({
        from_party: s.from_party,
        from_name: nameOf(s.from_party),
        to_party: s.to_party,
        to_name: nameOf(s.to_party),
        amount_minor: s.amount_minor,
        paid_on: s.paid_on,
      })),
      revisions,
      // Stated, not implied: a reader must not go looking for a total.
      balances_excluded: true,
      truncated: scoped.length > limit || settlements.length > limit,
      window: {
        limit,
        since,
        expenses: scoped.length,
        settlements: settlements.length,
      },
    };
  } catch (error) {
    return {
      group: null,
      expenses: [],
      settlements: [],
      revisions: [],
      balances_excluded: true,
      truncated: false,
      window: emptyWindow,
      vaultDenied: deniedPayload(error),
    };
  }
}

// The ledger a Tally parity run is built from (#1020, wave 2 lane D3).
//
// Every case here is one v0's own tests found hard: the departed member is
// `group-departed.test.ts`, the three currencies are drift ONT-23, the uneven
// payers are ruling O-payers, the odd amount over three sharers is where a
// pro-rating attribution and a matched-off one part company, and the trashed
// expense is the one row `deleted_at IS NULL` has to exclude from a balance and
// include on the trash shelf.
//
// It writes through the REAL typed commands and nothing else — no direct SQL,
// no row it invented — so what the fixture pins is what the product does.

/** The day expenses are spent on, a month before the run's epoch. */
export const SPENT_ON = "2099-05-04";

/** The day the settlement is paid on, inside the epoch's month. */
export const PAID_ON = "2099-05-20";

/**
 * The ledger the fixture is built from: three currencies, uneven payers, a
 * settlement, a group-less obligation-free 1:1 expense, a trashed expense, a
 * departed member and a recurring template with an exception.
 *
 * Every one of those is a case v0's own tests found hard: the departed member
 * is `group-departed.test.ts`, the three currencies are drift ONT-23, the
 * uneven payers are ruling O-payers, and the trashed expense is the one row
 * `deleted_at IS NULL` has to exclude from a balance and include in the trash
 * shelf.
 */
export function seedLedger(
  execute: <T>(command: string, input: Record<string, unknown>) => T,
  owner: string
): void {
  const friend = (name: string): string =>
    execute<{ party_id: string }>("tally.add_friend", { name }).party_id;
  const ana = friend("Ana");
  const bo = friend("Bo");
  const cleo = friend("Cleo");

  const group = (name: string, currency: string, members: string[]): string =>
    execute<{ group_id: string }>("tally.create_group", {
      name,
      icon: "🏠",
      currency,
      member_ids: members,
    }).group_id;
  const flat = group("Sitwell Road", "GBP", [ana, bo]);
  const trip = group("Lisbon", "EUR", [ana, cleo]);
  const tokyo = group("Tokyo", "JPY", [bo]);

  const expense = (
    groupId: string | null,
    description: string,
    amountMinor: number,
    paidBy: string,
    splits: { party_id: string; share_minor: number }[],
    extra: Record<string, unknown> = {}
  ): string =>
    execute<{ expense_id: string }>("tally.add_expense", {
      // OMITTED rather than null when there is no group: the command's schema
      // is `additionalProperties: false` with `group_id` a non-empty string,
      // and a group-less 1:1 expense is the ABSENCE of the key (GAPS #4).
      ...(groupId === null ? {} : { group_id: groupId }),
      description,
      amount_minor: amountMinor,
      paid_by: paidBy,
      category: "groceries",
      spent_on: SPENT_ON,
      splits,
      ...extra,
    }).expense_id;

  // An odd amount over three sharers: the remainder is where a pro-rating
  // attribution and a matched-off one part company.
  expense(flat, "Groceries", 10_001, owner, [
    { party_id: owner, share_minor: 3_334 },
    { party_id: ana, share_minor: 3_334 },
    { party_id: bo, share_minor: 3_333 },
  ]);
  // Two payers, neither of them the only sharer.
  expense(
    flat,
    "Boiler service",
    24_000,
    ana,
    [
      { party_id: owner, share_minor: 8_000 },
      { party_id: ana, share_minor: 8_000 },
      { party_id: bo, share_minor: 8_000 },
    ],
    {
      payers: [
        { party_id: ana, paid_minor: 14_000 },
        { party_id: bo, paid_minor: 10_000 },
      ],
    }
  );
  // The same nominal 10,000 in two other currencies: the position is three
  // balances and nothing is 30,000 (drift ONT-23).
  expense(trip, "Pastéis", 10_000, owner, [
    { party_id: owner, share_minor: 5_000 },
    { party_id: cleo, share_minor: 5_000 },
  ]);
  // JPY has no minor unit, which is what v0's formatter gets wrong.
  expense(tokyo, "Ramen", 4_200, bo, [
    { party_id: owner, share_minor: 2_100 },
    { party_id: bo, share_minor: 2_100 },
  ]);
  // A group-less 1:1 expense, whose participants are validated against the
  // friend roster rather than a circle.
  expense(null, "Cinema", 2_500, owner, [
    { party_id: owner, share_minor: 1_250 },
    { party_id: ana, share_minor: 1_250 },
  ]);
  // Typed lines, so the line-item and allocation fan-outs are exercised.
  expense(
    flat,
    "Hardware shop",
    3_000,
    bo,
    [
      { party_id: owner, share_minor: 2_000 },
      { party_id: bo, share_minor: 1_000 },
    ],
    {
      split_method: "by_line",
      line_items: [
        {
          kind: "item",
          description: "Paint",
          amount_minor: 2_000,
          allocations: [{ party_id: owner, share_minor: 2_000 }],
        },
        {
          kind: "item",
          description: "Brushes",
          amount_minor: 1_000,
          allocations: [{ party_id: bo, share_minor: 1_000 }],
        },
      ],
    }
  );
  // The trashed one: excluded from every balance, present on the trash shelf.
  const doomed = expense(flat, "Cancelled order", 1_500, owner, [
    { party_id: owner, share_minor: 750 },
    { party_id: ana, share_minor: 750 },
  ]);
  execute("tally.delete_expense", { expense_id: doomed });

  // Real cash, in the group's currency.
  execute("tally.settle_up", {
    from_party: ana,
    to_party: owner,
    amount_minor: 5_000,
    currency: "GBP",
    group_id: flat,
    paid_on: PAID_ON,
  });

  // A member who left: `leave_group` rather than `remove_group_member`, because
  // the latter's precondition is `member_off_ledger` and Bo is on the ledger.
  // The rows stay, marked departed, and every expense that still names them
  // must stay nameable (`group-departed.test.ts`).
  execute("tally.leave_group", { group_id: flat, party_id: bo });

  // Simplification is opt-in, and the flag is the only thing stored.
  execute("tally.set_group_simplification", { group_id: flat, simplify: true });

  // A standing order and one occurrence overridden, so the template dashboard
  // and the occurrence adapter both have something to read.
  const template = execute<{ template_id: string }>(
    "tally.save_recurring_expense",
    {
      group_id: flat,
      description: "Broadband",
      original_amount_minor: 3_500,
      original_currency: "GBP",
      // Required, not optional: a template states the money it settles in.
      settlement_currency: "GBP",
      paid_by: owner,
      category: "utilities",
      // A template carries WEIGHTS, not resolved shares: the occurrence is
      // what resolves them, and the rate may move between occurrences.
      splits: [
        { party_id: owner, weight: 1 },
        { party_id: ana, weight: 1 },
      ],
      // Plain `FREQ=MONTHLY`: `BYMONTHDAY` is on the expander's unsupported
      // list, because it pins occurrences to days of the month while the
      // expander steps from the anchor day (`rrule-support.ts:26-34`).
      rrule: "FREQ=MONTHLY",
      anchor_start: "2099-01-01T09:00:00",
      tz: "Europe/London",
      status: "active",
    }
  ).template_id;
  execute("tally.edit_recurring_expense_occurrence", {
    template_id: template,
    original_start_local: "2099-07-01T09:00:00",
    scope: "occurrence",
    action: "skip",
  });

  // A prepared nudge. Nothing is ever sent from here.
  execute("tally.nudge", {
    party_id: ana,
    group_id: flat,
    as_of_minor: 1_250,
    note: "when you get a chance",
  });
}

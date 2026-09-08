/*
 * THE MORNING VIEW GOES THROUGH THE GATEWAY (#916, review-A 8.1). This is
 * LIFE DATA — events, tasks, photos, money — so it is read the way an app
 * reads it: `gateway.read` per entity, on the owner's own credential, with a
 * receipt written. Nothing here prepares SQL against a physical table, which
 * is what `bun run lint:vault-sql` enforces.
 *
 * The four joins the old SQL did are folded HERE instead, over windowed reads.
 * That is the price of the boundary and it is the right one: a brief is a
 * handful of rows a day, and the alternative was a reader with no consent
 * check, no receipt, and — until #916 — no soft-delete filter either.
 */

import { expandRecurrence } from "@centraid/core/time";
import type { RecurrenceSemantics } from "@centraid/core/time";
import type { Credential, ReadRequest, ReadResult } from "@centraid/vault";

/** The gateway surface a brief needs — the whole of it. */
export interface BriefVaultReader {
  read: (cred: Credential, request: ReadRequest) => ReadResult;
}

/** Tasks are ordered by due date then priority, and `OrderBy` names ONE
 *  column — so the window is read wide and the tiebreak folded here. */
const TASK_WINDOW = 64;
const TASK_SHELF = 8;
const EVENT_SHELF = 8;

export interface DailyBrief {
  date: string;
  events: Array<{ id: string; title: string; at: string }>;
  tasks: Array<{ id: string; title: string; dueAt: string }>;
  newPhotos: number;
  balanceMinor: number;
  currency: string;
}

interface EventRow {
  event_id: string;
  summary: string;
  dtstart: string;
  rrule: string | null;
  start_tz: string | null;
  recurrence_semantics: RecurrenceSemantics;
}

interface TaskRow {
  task_id: string;
  title: string;
  due_at: string;
  priority?: number | null;
}

interface ExpenseRow {
  expense_id: string;
  settlement_currency?: string | null;
}

interface PartyAmountRow {
  expense_id: string;
  party_id: string;
  paid_minor?: number | null;
  share_minor?: number | null;
}

interface SettlementRow {
  from_party: string;
  to_party: string;
  amount_minor: number;
}

function rowsOf<T>(result: ReadResult): T[] {
  return (result.rows ?? []) as unknown as T[];
}

/** One content-minimized, read-only morning view over the four daily domains. */
export function buildDailyBrief(
  vault: BriefVaultReader,
  cred: Credential,
  input: { date: string; from: string; to: string; timeZone: string }
): DailyBrief {
  const read = (request: ReadRequest): ReadResult => vault.read(cred, request);

  // Every live event, because a recurrence that started years ago can land
  // inside today's window; the expansion below is what narrows it.
  const events = rowsOf<EventRow>(
    read({
      entity: "core.event",
      where: [
        { column: "status", op: "ne", value: "cancelled" },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "dtstart", dir: "asc" },
    })
  )
    .flatMap((event) => {
      if (!event.rrule) {
        return event.dtstart >= input.from && event.dtstart < input.to
          ? [{ id: event.event_id, title: event.summary, at: event.dtstart }]
          : [];
      }
      return expandRecurrence({
        rrule: event.rrule,
        start: event.dtstart,
        rangeFrom: input.from,
        rangeTo: input.to,
        timeZone: event.start_tz ?? input.timeZone,
        semantics: event.recurrence_semantics,
        maxInstances: 20,
      }).map((instance) => ({
        id: `${event.event_id}:${instance.originalStart}`,
        title: event.summary,
        at: instance.start,
      }));
    })
    .toSorted((left, right) => left.at.localeCompare(right.at))
    .slice(0, EVENT_SHELF);

  const tasks = rowsOf<TaskRow>(
    read({
      entity: "schedule.task",
      where: [
        {
          column: "status",
          op: "in",
          value: ["needs-action", "in-process"],
        },
        { column: "deleted_at", op: "is-null" },
        { column: "due_at", op: "not-null" },
        { column: "due_at", op: "lt", value: input.to },
      ],
      orderBy: { column: "due_at", dir: "asc" },
      limit: TASK_WINDOW,
    })
  )
    .toSorted(
      (left, right) =>
        left.due_at.localeCompare(right.due_at) ||
        (right.priority ?? 0) - (left.priority ?? 0)
    )
    .slice(0, TASK_SHELF)
    .map((task) => ({
      id: task.task_id,
      title: task.title,
      dueAt: task.due_at,
    }));

  const newPhotos = rowsOf<{ asset_id: string }>(
    read({
      entity: "media.asset",
      where: [
        { column: "deleted_at", op: "is-null" },
        { column: "archived_at", op: "is-null" },
        { column: "captured_at", op: "gte", value: input.from },
        { column: "captured_at", op: "lt", value: input.to },
      ],
    })
  ).length;

  const vaultRow = rowsOf<{
    self_party_id: string;
    base_currency?: string | null;
  }>(read({ entity: "core.vault", limit: 1 }))[0];
  const selfPartyId = vaultRow?.self_party_id ?? "";
  const declared = vaultRow?.base_currency;
  const baseCurrency =
    typeof declared === "string" && /^[A-Za-z]{3}$/u.test(declared)
      ? declared.toUpperCase()
      : "USD";

  /*
   * What this seat is owed, in ONE currency (#916, review-A 4.2). The fold
   * read `tally_expense.paid_by` — the PRINCIPAL payer — so a multi-payer
   * expense credited the whole amount to one person; `tally.expense_payer`
   * carries the whole payer set (one degenerate row when there is one payer).
   * An expense settling in another currency is EXCLUDED, not folded: there is
   * no rate here that is not already applied, and adding minor units across
   * currencies is worse than reporting the base-currency position.
   * `tally.settlement` carries no currency, so it is base-currency by
   * construction.
   */
  const expenses = rowsOf<ExpenseRow>(
    read({
      entity: "tally.expense",
      where: [{ column: "deleted_at", op: "is-null" }],
    })
  );
  const baseCurrencyExpenses = new Set(
    expenses
      .filter((e) => (e.settlement_currency ?? baseCurrency) === baseCurrency)
      .map((e) => e.expense_id)
  );
  let balanceMinor = 0;
  if (baseCurrencyExpenses.size > 0 && selfPartyId !== "") {
    const expenseIds = [...baseCurrencyExpenses];
    for (const payer of rowsOf<PartyAmountRow>(
      read({
        entity: "tally.expense_payer",
        where: [
          { column: "party_id", op: "eq", value: selfPartyId },
          { column: "expense_id", op: "in", value: expenseIds },
        ],
      })
    ))
      balanceMinor += payer.paid_minor ?? 0;
    for (const split of rowsOf<PartyAmountRow>(
      read({
        entity: "tally.expense_split",
        where: [
          { column: "party_id", op: "eq", value: selfPartyId },
          { column: "expense_id", op: "in", value: expenseIds },
        ],
      })
    ))
      balanceMinor -= split.share_minor ?? 0;
  }

  if (selfPartyId !== "") {
    for (const settlement of rowsOf<SettlementRow>(
      read({
        entity: "tally.settlement",
        where: [{ column: "deleted_at", op: "is-null" }],
      })
    )) {
      if (settlement.from_party === selfPartyId)
        balanceMinor += settlement.amount_minor;
      else if (settlement.to_party === selfPartyId)
        balanceMinor -= settlement.amount_minor;
    }
  }

  return {
    date: input.date,
    events,
    tasks,
    newPhotos,
    balanceMinor,
    currency: baseCurrency,
  };
}

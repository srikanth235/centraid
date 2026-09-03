import { expandRecurrence } from "@centraid/core/time";
import type { RecurrenceSemantics } from "@centraid/core/time";
import type { Credential, ReadRequest, ReadResult } from "@centraid/vault";

export interface BriefVaultReader {
  read: (cred: Credential, request: ReadRequest) => ReadResult;
}

const PURPOSE = "dpv:ServiceProvision";

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

export function buildDailyBrief(
  vault: BriefVaultReader,
  cred: Credential,
  input: { date: string; from: string; to: string; timeZone: string }
): DailyBrief {
  const read = (request: ReadRequest): ReadResult =>
    vault.read(cred, { purpose: PURPOSE, ...request });

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

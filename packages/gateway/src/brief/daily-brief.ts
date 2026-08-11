import { expandRecurrence } from "@centraid/time-engine";
import type { RecurrenceSemantics } from "@centraid/time-engine";
import type { VaultDb } from "@centraid/vault";

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

/** One content-minimized, read-only morning view over the four daily domains. */
export function buildDailyBrief(
  db: VaultDb,
  input: { date: string; from: string; to: string; timeZone: string }
): DailyBrief {
  const events = (
    db.vault
      .prepare(
        `SELECT event_id, summary, dtstart, rrule, start_tz,
                recurrence_semantics
           FROM core_event
          WHERE status <> 'cancelled'
          ORDER BY dtstart`
      )
      .all() as unknown as EventRow[]
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
    .slice(0, 8);
  const tasks = (
    db.vault
      .prepare(
        `SELECT task_id AS id, title, due_at AS dueAt
           FROM schedule_task
          WHERE status IN ('needs-action','in-process')
            AND due_at IS NOT NULL AND due_at < ?
          ORDER BY due_at, priority DESC LIMIT 8`
      )
      .all(input.to) as unknown as Array<{
      id: string;
      title: string;
      dueAt: string;
    }>
  ).map((row) => row);
  const photo = db.vault
    .prepare(
      `SELECT COUNT(*) AS n FROM media_asset
        WHERE deleted_at IS NULL AND archived_at IS NULL
          AND COALESCE(captured_at, '') >= ? AND captured_at < ?`
    )
    .get(input.from, input.to) as { n: number };
  const vault = db.vault
    .prepare("SELECT owner_party_id, base_currency FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string; base_currency: string };
  const expenses = db.vault
    .prepare(
      `SELECT e.amount_minor, e.paid_by, COALESCE(s.share_minor, 0) AS owner_share
         FROM tally_expense e
         LEFT JOIN tally_expense_split s
           ON s.expense_id = e.expense_id AND s.party_id = ?
        WHERE e.deleted_at IS NULL`
    )
    .all(vault.owner_party_id) as unknown as Array<{
    amount_minor: number;
    paid_by: string;
    owner_share: number;
  }>;
  let balanceMinor = expenses.reduce(
    (sum, row) =>
      sum +
      (row.paid_by === vault.owner_party_id ? row.amount_minor : 0) -
      row.owner_share,
    0
  );
  const settlements = db.vault
    .prepare(
      `SELECT from_party, to_party, amount_minor FROM tally_settlement
        WHERE deleted_at IS NULL AND (from_party = ? OR to_party = ?)`
    )
    .all(vault.owner_party_id, vault.owner_party_id) as unknown as Array<{
    from_party: string;
    to_party: string;
    amount_minor: number;
  }>;
  for (const settlement of settlements) {
    balanceMinor +=
      settlement.from_party === vault.owner_party_id
        ? settlement.amount_minor
        : -settlement.amount_minor;
  }
  const currency =
    typeof vault.base_currency === "string" &&
    /^[A-Za-z]{3}$/u.test(vault.base_currency)
      ? vault.base_currency.toUpperCase()
      : "USD";
  return {
    date: input.date,
    events,
    tasks,
    newPhotos: photo.n,
    balanceMinor,
    currency,
  };
}

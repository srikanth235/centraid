import { metaSentence, money } from "./format.ts";
import type { ActivityRow, LedgerEntry, Role } from "./types.ts";
import { PENDING_ROW, paidBy } from "./view-copy.ts";

export interface EntryFacts {
  description: string;
  spent_on?: string;
  amount_minor: number;
  paid_by: string;
  paid_by_name: string;
  your_role: Role;
  your_amount_minor: number;
  enteredIn?: string;
  fromTemplate?: boolean;
  hasReceipt?: boolean;
  parked?: boolean;
  pending?: boolean;
  pendingRow?: Readonly<Record<string, unknown>> | null;
}

export function entryFacts(entry: LedgerEntry): EntryFacts {
  return {
    description: entry.description ?? "",
    ...(entry.spent_on ? { spent_on: entry.spent_on } : {}),
    amount_minor: entry.amount_minor,
    paid_by: entry.paid_by,
    paid_by_name: entry.paid_by_name,
    your_role: entry.your_role,
    your_amount_minor: entry.your_amount_minor,
    ...(entry.original_currency === entry.settlement_currency
      ? {}
      : { enteredIn: entry.original_currency }),
    fromTemplate: entry.recurring_template_id !== null,
    hasReceipt: entry.receipt !== undefined,
    ...(entry.parked === true ? { parked: true } : {}),
    ...(entry.pending === true ? { pending: true } : {}),
    pendingRow: entry as unknown as Record<string, unknown>,
  };
}

export function feedFacts(row: ActivityRow): EntryFacts {
  return {
    description: row.description ?? "",
    ...(row.date ? { spent_on: row.date } : {}),
    amount_minor: row.amount_minor,
    paid_by: row.paid_by ?? "",
    paid_by_name: row.paid_by_name ?? "",
    your_role: row.your_role ?? "none",
    your_amount_minor: row.your_amount_minor ?? 0,
  };
}

export interface EntryMetaInput {
  facts: EntryFacts;
  currency: string;
  me: string | null;
  groupName?: string;
  extra?: string;
}

export function entryMeta(input: EntryMetaInput): string {
  const { facts } = input;
  const isMine = facts.paid_by === input.me && input.me !== null;
  return metaSentence([
    facts.spent_on,
    `${paidBy(facts.paid_by_name, isMine)} ${money(facts.amount_minor, input.currency)}`,
    input.groupName,
    facts.enteredIn ? `entered in ${facts.enteredIn}` : "",
    facts.fromTemplate ? "from a template" : "",
    facts.hasReceipt ? "receipt attached" : "",
    input.extra,
    facts.pending === true ? PENDING_ROW : "",
  ]);
}

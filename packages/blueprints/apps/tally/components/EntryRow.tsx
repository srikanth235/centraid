// One EXPENSE, as the ledger row draws it — the meta sentence, the figure and
// the pending overlay, assembled once for every list that shows expenses.
//
// `LedgerRow` is the SHAPE; this is the SENTENCE. It exists separately because
// the sentence is where a list would drift: a group ledger, a friend's shared
// expenses, the activity feed, Trash and Search each know a slightly different
// amount about the same expense, and the parts they do not know have to DROP
// OUT rather than be guessed at. Everything in the sentence is read straight
// off the decorated row the query handed over — the payer's name, the currency
// it was entered in, whether it came from a template, whether a receipt is
// attached, whether the write has settled. Nothing here is derived.
//
// THE TWO ADAPTERS BELOW ARE THE WHOLE REASON THIS IS ONE COMPONENT. The
// ledgers hand over `LedgerEntry`, the feed hands over `ActivityRow`, and both
// narrow to the same `EntryFacts` — so a synthetic full ledger row never has
// to be minted at a call site just to reuse the row.
import type { ReactNode } from "react";

import { identityInitials } from "@centraid/design";

import { metaSentence, money, roleSubLabel, roleTone } from "../format.ts";
import type { ActivityRow, LedgerEntry, Role } from "../types.ts";
import { PENDING_ROW, paidBy } from "../view-copy.ts";
import { LedgerRow } from "./LedgerRow.tsx";
import type { RowAct } from "./LedgerRow.tsx";

/** Exactly what an expense row's sentence and figure need, and nothing else. */
export interface EntryFacts {
  description: string;
  spent_on?: string;
  amount_minor: number;
  paid_by: string;
  paid_by_name: string;
  your_role: Role;
  your_amount_minor: number;
  /** Present only where the expense was entered in something other than what
   *  the group settles in — then the row says so. */
  enteredIn?: string;
  fromTemplate?: boolean;
  hasReceipt?: boolean;
  parked?: boolean;
  /** The row as the query handed it over, for the shared overlay engine. */
  pendingRow?: Readonly<Record<string, unknown>> | null;
}

/** A decorated ledger row, narrowed to the facts the row draws. */
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
    pendingRow: entry as unknown as Record<string, unknown>,
  };
}

/** A feed row, narrowed the same way. The feed carries no splits, no receipt
 *  and no currency provenance, so those clauses are simply absent. */
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

export interface EntryRowProps {
  facts: EntryFacts;
  currency: string;
  /** The vault owner, so "you paid" is said as "you paid". */
  me: string | null;
  /** The group this expense sits in, where the caller knows it. On a group's
   *  own ledger every row is in the same group, so naming it on each row would
   *  be the heading repeated eight times. */
  groupName?: string;
  /** A clause the caller has and the row does not — a search hit's reason, a
   *  trashed row's purge date. */
  extra?: string;
  acts?: readonly RowAct[];
  narrow?: boolean;
  onOpen?: () => void;
}

export function EntryRow(props: EntryRowProps): ReactNode {
  const { facts } = props;
  const isMine = facts.paid_by === props.me && props.me !== null;
  const meta = metaSentence([
    facts.spent_on,
    `${paidBy(facts.paid_by_name, isMine)} ${money(facts.amount_minor, props.currency)}`,
    props.groupName,
    facts.enteredIn ? `entered in ${facts.enteredIn}` : "",
    facts.fromTemplate ? "from a template" : "",
    facts.hasReceipt ? "receipt attached" : "",
    props.extra,
    facts.pendingRow?.pending === true ? PENDING_ROW : "",
  ]);

  return (
    <LedgerRow
      chip={{
        partyId: facts.paid_by,
        initials: identityInitials(facts.paid_by_name),
      }}
      title={facts.description}
      meta={meta}
      figure={{
        text: money(facts.your_amount_minor, props.currency),
        tone: roleTone(facts.your_role),
        sub: roleSubLabel(facts.your_role),
      }}
      {...(facts.parked
        ? { status: { label: "Parked", tone: "seam" as const } }
        : {})}
      {...(facts.pendingRow ? { pendingRow: facts.pendingRow } : {})}
      {...(props.acts ? { acts: props.acts } : {})}
      {...(props.narrow === undefined ? {} : { narrow: props.narrow })}
      {...(props.onOpen ? { onOpen: props.onOpen } : {})}
    />
  );
}

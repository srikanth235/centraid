// ONE EXPENSE, AS A SENTENCE — the meta line every list in Tally puts under an
// expense's description, and the two narrowings that feed it.
//
// WHY THIS IS ITS OWN MODULE. The sentence is where a list drifts: a group
// ledger, a friend's shared expenses, the activity feed, Trash and Search each
// know a slightly different amount about the same expense, and the parts they
// do not know have to DROP OUT rather than be guessed at. Two seats drawing
// that sentence from two places is the same defect one step larger — the phone
// would say "receipt attached" where the desktop said nothing, and neither
// would be wrong about the data.
//
// It is PURE and JSX-free on purpose. `components/EntryRow.tsx` is a React
// component that imports web CSS modules, so a native seat cannot reach the
// narrowings that live beside it; this module holds the arithmetic-free half —
// the two adapters and the sentence — so both seats compose one row from one
// computation. Nothing here derives a figure: every `*_minor` arrives already
// folded by `queries/dashboard.ts`'s one balance engine.
import { metaSentence, money } from "./format.ts";
import type { ActivityRow, LedgerEntry, Role } from "./types.ts";
import { PENDING_ROW, paidBy } from "./view-copy.ts";

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
  /** Has this write settled in the vault? Read off the pending overlay the
   *  query decorated the row with, never guessed from an id. */
  pending?: boolean;
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
    ...(entry.pending === true ? { pending: true } : {}),
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

export interface EntryMetaInput {
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
}

/** The row's one meta sentence, joined the way every meta line in this room
 *  joins them. A part the caller does not know DROPS OUT. */
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

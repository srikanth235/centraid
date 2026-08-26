// THE RECEIPT'S ARITHMETIC — one line, one set of people, and the
// reconciliation stated as a sum (Tally spec §3, FLOWS.md).
//
// CAPTURE AND OCR BELONG TO THE PHONE. The lines arrive already reviewed from
// the origin seat's capture flow; what Tally owns is the ALLOCATION — who had
// what — and the proof that the lines are the expense. Stating that proof as
// arithmetic on the page is the whole point: a mis-allocation is visible before
// saving rather than after.
//
// THE LINE'S REMAINDER GOES TO THE EARLIER PARTY, not to the payer. An expense
// has someone who is out of pocket and the app's rule hands them the odd penny
// (`split-model.ts`); a LINE has no payer — four people sharing a bottle are
// four equal claims on it — so the tie-break is position, exactly as the
// phone's capture flow resolves it (`packages/client/src/receipt-capture.ts`
// `allocateMinorUnits`). Two seats allocating the same receipt differently
// would be two answers to one question.
import { money } from "./format.ts";
import { allocateWeighted } from "./split-model.ts";
import type { Share } from "./split-model.ts";
import type { ReceiptLine } from "./types.ts";

/** Which people a line is allocated to, keyed by the line's own id. */
export type LineSelection = Readonly<Record<string, readonly string[]>>;

/** Split one line equally between the people it was allocated to. */
export function allocateLine(
  amountMinor: number,
  partyIds: readonly string[]
): Share[] {
  return allocateWeighted(
    amountMinor,
    partyIds.map((party_id) => ({ party_id, value: 1 })),
    ""
  );
}

/** The allocation the vault already holds, as the selection the chips show. */
export function selectionOf(lines: readonly ReceiptLine[]): LineSelection {
  const out: Record<string, string[]> = {};
  for (const line of lines)
    out[line.line_item_id] = line.allocations.map(
      (allocation) => allocation.party_id
    );
  return out;
}

/** Is this person on this line, as the chip's pressed state? */
export function onLine(
  selection: LineSelection,
  lineId: string,
  partyId: string
): boolean {
  return (selection[lineId] ?? []).includes(partyId);
}

/** The selection with one person added to or taken off one line. */
export function toggleLine(
  selection: LineSelection,
  lineId: string,
  partyId: string
): LineSelection {
  const current = selection[lineId] ?? [];
  const next = current.includes(partyId)
    ? current.filter((id) => id !== partyId)
    : [...current, partyId];
  return { ...selection, [lineId]: next };
}

export interface Reconciliation {
  /** What the lines come to. */
  lineTotalMinor: number;
  /** What the expense says it is. */
  expenseMinor: number;
  /** Do the two agree, to the penny? */
  reconciles: boolean;
  /** The owner's own part of it, folded from the line allocations. */
  yoursMinor: number;
  /** Per person, in the shape `add-receipt-expense`'s `splits` requires. */
  shares: Share[];
  /** Every line that nobody is on — the mis-allocation the foot names. */
  unallocated: number;
  /** The foot's sentence, stated as arithmetic. */
  sentence: string;
}

/**
 * Fold the lines and their allocations into per-person totals and the sentence
 * the foot states. Pure, so the one place this arithmetic happens is a place a
 * test can stand in front of.
 */
export function reconcile(input: {
  lines: readonly ReceiptLine[];
  selection: LineSelection;
  expenseMinor: number;
  me: string | null;
  currency: string;
  /** The order per-person shares come out in, so a table and a write agree. */
  participants: readonly string[];
}): Reconciliation {
  const totals = new Map<string, number>(
    input.participants.map((party_id) => [party_id, 0])
  );
  let lineTotalMinor = 0;
  let unallocated = 0;
  for (const line of input.lines) {
    lineTotalMinor += line.amount_minor;
    const people = input.selection[line.line_item_id] ?? [];
    if (people.length === 0) {
      unallocated += 1;
      continue;
    }
    for (const share of allocateLine(line.amount_minor, people))
      totals.set(
        share.party_id,
        (totals.get(share.party_id) ?? 0) + share.share_minor
      );
  }
  const shares = [...totals.entries()].map(([party_id, share_minor]) => ({
    party_id,
    share_minor,
  }));
  const reconciles = lineTotalMinor === input.expenseMinor;
  const yoursMinor = input.me === null ? 0 : (totals.get(input.me) ?? 0);
  const agreement = reconciles ? "they reconcile" : "they do not reconcile";
  const count = input.lines.length;
  const sentence = `${count} ${count === 1 ? "line totals" : "lines total"} ${money(lineTotalMinor, input.currency)} · the expense is ${money(input.expenseMinor, input.currency)} · ${agreement}. Yours comes to ${money(yoursMinor, input.currency)}.`;
  return {
    lineTotalMinor,
    expenseMinor: input.expenseMinor,
    reconciles,
    yoursMinor,
    shares,
    unallocated,
    sentence,
  };
}

/** What a line's kind is CALLED on the row. Tax and tip are lines like any
 *  other and are allocated like any other; the word is the only difference. */
export const LINE_KIND_LABEL: Readonly<Record<ReceiptLine["kind"], string>> = {
  item: "",
  tax: "tax",
  tip: "service",
};

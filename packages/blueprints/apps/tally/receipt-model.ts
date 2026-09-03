import { money } from "./format.ts";
import { allocateLine } from "./line-model.ts";
import type { LineItemInput } from "./line-model.ts";
import type { Share } from "./split-model.ts";
import type { ReceiptLine } from "./types.ts";

export type LineSelection = Readonly<Record<string, readonly string[]>>;

export { allocateLine } from "./line-model.ts";

export function selectionOf(lines: readonly ReceiptLine[]): LineSelection {
  const out: Record<string, string[]> = {};
  for (const line of lines)
    out[line.line_item_id] = line.allocations.map(
      (allocation) => allocation.party_id
    );
  return out;
}

export function onLine(
  selection: LineSelection,
  lineId: string,
  partyId: string
): boolean {
  return (selection[lineId] ?? []).includes(partyId);
}

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
  lineTotalMinor: number;
  expenseMinor: number;
  reconciles: boolean;
  yoursMinor: number;
  shares: Share[];
  unallocated: number;
  sentence: string;
}

export function reconcile(input: {
  lines: readonly ReceiptLine[];
  selection: LineSelection;
  expenseMinor: number;
  me: string | null;
  currency: string;
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
  const count = input.lines.length;
  const noun = count === 1 ? "line totals" : "lines total";
  const sentence = `${count} ${noun} ${money(lineTotalMinor, input.currency)}, the expense is ${money(input.expenseMinor, input.currency)}, yours is ${money(yoursMinor, input.currency)}${reconciles ? "" : " · they do not reconcile"}`;
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

export function receiptLineItems(
  lines: readonly ReceiptLine[],
  selection: LineSelection
): LineItemInput[] {
  return lines.map((line) => ({
    kind: line.kind,
    description: line.description,
    amount_minor: line.amount_minor,
    allocations: allocateLine(
      line.amount_minor,
      selection[line.line_item_id] ?? []
    ),
  }));
}

export const LINE_KIND_LABEL: Readonly<Record<ReceiptLine["kind"], string>> = {
  item: "",
  tax: "tax",
  tip: "service",
};

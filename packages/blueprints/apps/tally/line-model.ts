// TYPED LINES — the sixth division, shared by *By line* on Add expense and
// Receipt's allocation editor, so two seats cannot disagree about one receipt
// (Tally spec §3).
//
// THE LINE'S REMAINDER GOES TO THE EARLIER PARTY, not to the payer — a line
// has no payer, so the tie-break is position, as `receipt-capture.ts` does it.
import { parseMoneyText } from "./money-text.ts";
import { allocateWeighted } from "./split-model.ts";
import type { Allocation, Share } from "./split-model.ts";
import type { ReceiptLine } from "./types.ts";

export interface LineDraft {
  lineId: string;
  kind: ReceiptLine["kind"];
  description: string;
  amount: string;
  who: string[];
}

export interface LineItemInput {
  kind: ReceiptLine["kind"];
  description: string;
  amount_minor: number;
  allocations: Share[];
  [key: string]: unknown;
}

/**
 * A LINE ID IS SEAT-SCOPED AND SORTS BY CREATION (#1020, R-1020-35).
 *
 * This was `line-${++seq}` off a module-level counter. Two seats composing the
 * same receipt offline both start at `line-1`, so their drafts collide on
 * merge: one seat's tax line and the other's tip line are the same row, and
 * the allocation editor reconciles them into one. A counter cannot be made
 * safe here — the point of a draft is that it exists before the vault has seen
 * it, so there is nothing to ask for a unique number.
 *
 * The shape is the expense id's: a time prefix so ids sort by creation, then
 * randomness wide enough that two seats in the same millisecond do not meet.
 * `crypto.getRandomValues` is present on every seat this module runs on —
 * browser, Node and Hermes — and `Date.now` is monotonic enough for an
 * ordering that only has to be stable within one draft.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** A fresh line id: `line-<ms in base 36>-<80 random bits>`. */
export function newLineId(): string {
  return `line-${Date.now().toString(36)}-${randomSuffix()}`;
}

export function newLineDraft(): LineDraft {
  return {
    lineId: newLineId(),
    kind: "item",
    description: "",
    amount: "",
    who: [],
  };
}

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

/** A line nobody is on carries NO allocations rather than being dropped —
 *  hiding it would reconcile while the expense stayed mis-allocated. */
export function lineItems(lines: readonly LineDraft[]): LineItemInput[] {
  return lines
    .filter((line) => line.description.trim() !== "")
    .map((line) => ({
      kind: line.kind,
      description: line.description.trim(),
      amount_minor: parseMoneyText(line.amount) ?? 0,
      allocations: allocateLine(parseMoneyText(line.amount) ?? 0, line.who),
    }));
}

export function lineShares(
  items: readonly LineItemInput[],
  participants: readonly string[]
): Share[] {
  const totals = new Map<string, number>(
    participants.map((party_id) => [party_id, 0])
  );
  for (const item of items)
    for (const allocation of item.allocations)
      totals.set(
        allocation.party_id,
        (totals.get(allocation.party_id) ?? 0) + allocation.share_minor
      );
  return [...totals.entries()].map(([party_id, share_minor]) => ({
    party_id,
    share_minor,
  }));
}

export function lineTotal(items: readonly LineItemInput[]): number {
  return items.reduce((sum, item) => sum + item.amount_minor, 0);
}

export function unallocatedCount(items: readonly LineItemInput[]): number {
  return items.filter((item) => item.allocations.length === 0).length;
}

export function allocateByLine(input: {
  lines: readonly LineDraft[];
  amountMinor: number;
  participants: readonly string[];
  me: string | null;
  currency: string;
  money: (minor: number, currency: string) => string;
}): Allocation {
  const items = lineItems(input.lines);
  const shares = lineShares(items, input.participants);
  const total = lineTotal(items);
  const balanced = total === input.amountMinor && items.length > 0;
  const yours =
    input.me === null
      ? 0
      : (shares.find((share) => share.party_id === input.me)?.share_minor ?? 0);
  const count = items.length;
  const noun = count === 1 ? "line totals" : "lines total";
  const line = `${count} ${noun} ${input.money(total, input.currency)}, the expense is ${input.money(input.amountMinor, input.currency)}, yours is ${input.money(yours, input.currency)}`;
  return { shares, ok: balanced, balanced, line };
}

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

let seq = 0;

export function newLineDraft(): LineDraft {
  seq += 1;
  return {
    lineId: `line-${seq}`,
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

import { allocateMinorUnits } from "@centraid/client/receipt-capture";
import type { ReceiptDraft } from "@centraid/client/receipt-capture";

export interface ScannedLine {
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  allocations: { party_id: string; share_minor: number }[];
}

export function scannedLines(
  receipt: ReceiptDraft,
  allocations: Readonly<Record<string, readonly string[]>>,
  participantIds: readonly string[]
): ScannedLine[] {
  return receipt.lines.map((line) => {
    const selected = allocations[line.id] ?? participantIds;
    if (selected.length === 0)
      throw new Error(`Choose who shares "${line.description}".`);
    return {
      kind: line.kind,
      description: line.description,
      amount_minor: line.amountMinor,
      allocations: allocateMinorUnits(line.amountMinor, [...selected]),
    };
  });
}

export function scannedSplits(
  lines: readonly ScannedLine[]
): { party_id: string; share_minor: number }[] {
  const totals = new Map<string, number>();
  for (const line of lines)
    for (const allocation of line.allocations)
      totals.set(
        allocation.party_id,
        (totals.get(allocation.party_id) ?? 0) + allocation.share_minor
      );
  return [...totals].map(([party_id, share_minor]) => ({
    party_id,
    share_minor,
  }));
}

export const SCANNED_RECEIPT_CATEGORY = "food";

export interface ScannedReceiptInput {
  group_id: string;
  description: string;
  amount_minor: number;
  paid_by: string;
  spent_on: string;
  category: string;
  ocr_text: string;
  splits: { party_id: string; share_minor: number }[];
  line_items: ScannedLine[];
}

export function scannedReceiptExpense(input: {
  receipt: ReceiptDraft;
  allocations: Readonly<Record<string, readonly string[]>>;
  participantIds: readonly string[];
  groupId: string;
  ownerId: string;
  ocrText: string;
  today: string;
}): ScannedReceiptInput {
  const lines = scannedLines(
    input.receipt,
    input.allocations,
    input.participantIds
  );
  return {
    group_id: input.groupId,
    description: input.receipt.merchant,
    amount_minor: input.receipt.amountMinor,
    paid_by: input.ownerId,
    spent_on: input.today,
    category: SCANNED_RECEIPT_CATEGORY,
    ocr_text: input.ocrText,
    splits: scannedSplits(lines),
    line_items: lines,
  };
}

// THE SCANNER'S TALLY DESTINATION — the origin seat's half of Receipt.
//
// SURFACES.md gives Receipt to `origin (read on others)`: the camera and the
// OCR pass live on this phone and nowhere else, so this is where a photographed
// bill becomes a receipt-backed expense. What Tally then owns is the
// ALLOCATION — who had what — and that is `apps/tally/receipt-model.ts`, shared
// by every seat.
//
// THE PAYLOAD IS BUILT HERE, NOT IN THE SCREEN, for the same reason
// `scan-consent.ts`, `scan-ui.tsx` and `scan-locker.ts` sit beside `Scan.tsx`:
// the screen is a FLOW, and each destination's payload is a table. The frame
// may not import an app (`scripts/check-import-boundaries.ts`), so the shares
// are folded from the per-line allocations here, out of the client's own
// `allocateMinorUnits` — the same tie-break `line-model.ts` applies, so a
// receipt cut on the phone and one cut in Tally agree to the penny.
//
// THIS WRITE IS NOT ONLINE-ONLY. Unlike a scanned card, a receipt carries no
// secret: Tally is record-only and fully offline-capable, so the expense takes
// the ordinary replica path, projects optimistically and queues when the
// gateway is out of reach. The one Tally write with no optimistic copy is
// materialising a recurring occurrence, and it is nowhere near this flow.

import { allocateMinorUnits } from "@centraid/client/receipt-capture";
import type { ReceiptDraft } from "@centraid/client/receipt-capture";

/** One reviewed line, with the people the member pressed onto it. */
export interface ScannedLine {
  kind: "item" | "tax" | "tip";
  description: string;
  amount_minor: number;
  allocations: { party_id: string; share_minor: number }[];
}

/** A line nobody was pressed onto falls back to everyone in the group, which
 *  is what the capture flow's chips start from — never to nobody, because a
 *  line allocated to nobody would make the reconciliation lie. */
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

/** Per-person shares, folded from the line allocations. The lines are the
 *  facts; the splits are their sum, and the command re-validates that they
 *  come to the expense. */
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

/** The default category a scanned receipt lands under. Nine, closed — and a
 *  bill photographed at a table is food until the member edits it, which the
 *  expense's own Edit route is for. */
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

/** Everything `add-receipt-expense` declares, out of one reviewed capture. */
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

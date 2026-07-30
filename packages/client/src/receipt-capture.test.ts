import { describe, expect, it } from "vitest";

import { allocateMinorUnits, parseReceiptText } from "./receipt-capture.js";

describe("review-first receipt extraction", () => {
  it("extracts items, tax, tip, merchant, currency, and the stated total", () => {
    expect(
      parseReceiptText(
        "Maya Cafe\nPasta ₹10.00\nTax ₹1.00\nTip ₹2.00\nTotal ₹13.00"
      )
    ).toMatchObject({
      amountMinor: 1_300,
      currency: "INR",
      merchant: "Maya Cafe",
      needsReview: false,
      lines: [
        { amountMinor: 1_000, description: "Pasta", kind: "item" },
        { amountMinor: 100, description: "Tax", kind: "tax" },
        { amountMinor: 200, description: "Tip", kind: "tip" },
      ],
    });
  });

  it("makes an OCR gap explicit instead of silently changing the total", () => {
    const result = parseReceiptText("Cafe\nCoffee $5.00\nTotal $6.00");
    expect(result.lines.at(-1)).toMatchObject({
      amountMinor: 100,
      description: "Unitemized amount",
    });
  });

  it("allocates rounding remainders deterministically", () => {
    expect(allocateMinorUnits(100, ["a", "b", "c"])).toStrictEqual([
      { party_id: "a", share_minor: 34 },
      { party_id: "b", share_minor: 33 },
      { party_id: "c", share_minor: 33 },
    ]);
  });
});

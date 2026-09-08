export type ReceiptLineKind = "item" | "tax" | "tip";

export interface ReceiptLineDraft {
  id: string;
  kind: ReceiptLineKind;
  description: string;
  amountMinor: number;
}

export interface ReceiptDraft {
  merchant: string;
  amountMinor: number;
  currency: string;
  lines: ReceiptLineDraft[];
  needsReview: boolean;
}

function findLastRow<T>(rows: readonly T[], match: (row: T) => boolean) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row !== undefined && match(row)) return row;
  }
  return undefined;
}

const MONEY_AT_END =
  /(?:^|\s)(?<symbol>[$€£₹])?\s*(?<amount>\d{1,8}(?:[.,]\d{2}))\s*$/u;
const TOTAL = /\b(?:grand\s+total|amount\s+due|total)\b/iu;
const IGNORE = /\b(?:subtotal|payment|cash|change|visa|mastercard)\b/iu;
const CURRENCY: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
};

function parseAmount(line: string): {
  amountMinor: number;
  symbol?: string;
  description: string;
} | null {
  const match = MONEY_AT_END.exec(line);
  const amountText = match?.groups?.amount;
  if (!amountText) return null;
  const amount = Number(amountText.replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return {
    amountMinor: Math.round(amount * 100),
    ...(match.groups?.symbol ? { symbol: match.groups.symbol } : {}),
    description: line
      .slice(0, match.index)
      .trim()
      .replace(/[.:·-]+$/u, ""),
  };
}

/**
 * Deterministic first pass over untrusted OCR text. It never publishes: the
 * caller presents every line, allocation, and total for review first.
 */
export function parseReceiptText(raw: string): ReceiptDraft {
  const rows = raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const parsed = rows
    .map((row, index) => ({ index, row, money: parseAmount(row) }))
    .filter(
      (
        value
      ): value is {
        index: number;
        row: string;
        money: NonNullable<ReturnType<typeof parseAmount>>;
      } => value.money !== null
    );
  const total = findLastRow(parsed, ({ row }) => TOTAL.test(row));
  const currency =
    parsed
      .map(({ money }) => money.symbol)
      .find((symbol): symbol is string => Boolean(symbol)) ?? "$";
  const lines: ReceiptLineDraft[] = parsed
    .filter(({ row }) => !TOTAL.test(row) && !IGNORE.test(row))
    .map(({ index, row, money }) => ({
      id: `ocr-${index}`,
      kind: /\btax\b/iu.test(row)
        ? "tax"
        : /\b(?:tip|gratuity)\b/iu.test(row)
          ? "tip"
          : "item",
      description: money.description || row,
      amountMinor: money.amountMinor,
    }));
  const lineTotal = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const amountMinor = total?.money.amountMinor ?? lineTotal;
  if (amountMinor > lineTotal) {
    lines.push({
      id: "ocr-unitemized",
      kind: "item",
      description: "Unitemized amount",
      amountMinor: amountMinor - lineTotal,
    });
  }
  const merchant =
    rows.find((row) => !parseAmount(row) && row.length <= 100) ?? "Receipt";
  return {
    merchant,
    amountMinor,
    currency: CURRENCY[currency] ?? "USD",
    lines,
    needsReview:
      !total ||
      lines.length === 0 ||
      lines.reduce((sum, line) => sum + line.amountMinor, 0) !== amountMinor,
  };
}

/** Equal allocation with deterministic remainder assignment to earlier parties. */
export function allocateMinorUnits(
  amountMinor: number,
  partyIds: readonly string[]
): Array<{ party_id: string; share_minor: number }> {
  if (partyIds.length === 0) return [];
  const base = Math.floor(amountMinor / partyIds.length);
  let remainder = amountMinor - base * partyIds.length;
  return partyIds.map((partyId) => ({
    party_id: partyId,
    share_minor: base + (remainder-- > 0 ? 1 : 0),
  }));
}

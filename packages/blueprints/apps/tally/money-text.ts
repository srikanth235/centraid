// TYPED TEXT → MINOR UNITS, in one place.
//
// Lifted out of `draft-model.ts` so `line-model.ts` can read a typed amount
// without importing the draft — the draft imports the lines, and a module that
// only knows how to read a number should never be the reason two files point
// at each other.

/** Minor units from typed text, or `null` when it is not a number at all. A
 *  blank field is `null` rather than zero: nobody typed a zero. */
export function parseMoneyText(text: string): number | null {
  const trimmed = text.trim().replaceAll(",", "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** A typed amount that may carry a leading minus — the adjustment column, and
 *  the only place in this app where a negative number is a legitimate entry. */
export function parseSignedMoneyText(text: string): number {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const minor = parseMoneyText(negative ? trimmed.slice(1) : trimmed);
  if (minor === null) return 0;
  return negative ? -minor : minor;
}

export function parseMoneyText(text: string): number | null {
  const trimmed = text.trim().replaceAll(",", "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function parseSignedMoneyText(text: string): number {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const minor = parseMoneyText(negative ? trimmed.slice(1) : trimmed);
  if (minor === null) return 0;
  return negative ? -minor : minor;
}

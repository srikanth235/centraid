import type { LockerAccessEntry, LockerRow } from "./types.ts";

export function accessVerb(entry: LockerAccessEntry): string {
  if (entry.decision === "deny") return "Refused";
  if (entry.kind === "auth") return "Unlocked";
  if (entry.kind === "fill") return "Filled";
  return "Revealed";
}

const COLUMN_WORD: Readonly<Record<string, string>> = {
  password: "password",
  card_number: "card number",
  cvv: "security code",
  content: "note",
  otp_seed: "one-time code",
  value_sealed: "custom field",
  private_key: "passkey key",
};

export function columnWords(columns: readonly string[] | undefined): string {
  return (columns ?? [])
    .map((column) => COLUMN_WORD[column] ?? column)
    .join(", ");
}

export function accessMeta(
  entry: LockerAccessEntry,
  title?: string | null
): string {
  const columns = columnWords(entry.columns);
  return [
    title ?? null,
    columns || null,
    entry.origin ? `on ${entry.origin}` : null,
    entry.reason ?? null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("  ·  ");
}

export function accessAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function titlesOf(rows: readonly LockerRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.item_id, row.title]));
}

export function accessWindowCopy(shown: number, truncated: boolean): string {
  if (shown === 0) return "";
  return truncated
    ? `${shown} receipts, and older ones beyond them · the window is 200 by default and 2,000 at most.`
    : `${shown} receipts · the window is 200 by default and 2,000 at most.`;
}

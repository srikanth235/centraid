import { DAY_MS } from "../_shared/format-kit.ts";
import { readPendingOverlay } from "../_shared/pending-overlay.ts";
import { displayText } from "../_shared/untrusted.ts";
import type {
  CheckKey,
  ItemFilter,
  LockerItemType,
  LockerRow,
  Verdict,
} from "./types.ts";
import { TYPE_LABEL, TYPE_ORDER, WINDOW_RULE } from "./view-copy.ts";

export function typeChip(type: LockerItemType): string {
  return (TYPE_LABEL[type] ?? "Item").slice(0, 2).toUpperCase();
}

export function typeLabel(type: LockerItemType | string): string {
  return TYPE_LABEL[type as LockerItemType] ?? "Item";
}

export function metaSentence(row: LockerRow): string {
  const tags = (row.tags ?? []).map((tag) => `#${tag}`).join(" ");
  return [typeLabel(row.type), row.subtitle, tags]
    .filter((part): part is string => Boolean(part) && part !== "—")
    .map((part) => displayText(part))
    .join("  ·  ");
}

export function verdictOf(row: LockerRow): Verdict | null {
  if (row.compromised) return { label: "COMPROMISED", tone: "net" };
  if (row.reused) return { label: "REUSED", tone: "seam" };
  if (row.weak) return { label: "WEAK", tone: "seam" };
  return null;
}

export function byTitle(a: LockerRow, b: LockerRow): number {
  return String(a.title ?? "").localeCompare(String(b.title ?? ""));
}

export function needsReview(row: LockerRow): boolean {
  return Boolean(row.compromised || row.reused || row.weak);
}

export const EXPIRY_HORIZON_DAYS = 90;

export function isUnsecuredAddress(row: LockerRow): boolean {
  return /^http:\/\//iu.test(String(row.url ?? ""));
}

export function daysUntilExpiry(
  expiry: string | null | undefined,
  now: number
): number | null {
  const text = String(expiry ?? "").replaceAll(/\s/gu, "");
  const slash = /^(?<mm>\d{1,2})\/(?<yy>\d{2}|\d{4})$/u.exec(text);
  const iso = /^(?<year>\d{4})-(?<month>\d{1,2})$/u.exec(text);
  let year: number;
  let month: number;
  if (slash?.groups) {
    month = Number(slash.groups["mm"]);
    const raw = Number(slash.groups["yy"]);
    year = raw < 100 ? 2000 + raw : raw;
  } else if (iso?.groups) {
    year = Number(iso.groups["year"]);
    month = Number(iso.groups["month"]);
  } else {
    return null;
  }
  if (month < 1 || month > 12) return null;
  const end = Date.UTC(year, month, 1);
  return Math.ceil((end - now) / DAY_MS);
}

export function isExpiringSoon(row: LockerRow, now: number): boolean {
  if (row.type !== "card") return false;
  const days = daysUntilExpiry(row.expiry, now);
  return days !== null && days <= EXPIRY_HORIZON_DAYS;
}

export const PASSWORD_AGE_HORIZON_DAYS = 365;

export function isPasswordStale(row: LockerRow, now: number): boolean {
  if (!row.password_set_at) return false;
  const set = new Date(row.password_set_at).getTime();
  if (Number.isNaN(set)) return false;
  return (now - set) / DAY_MS > PASSWORD_AGE_HORIZON_DAYS;
}

export function matchesCheck(
  row: LockerRow,
  check: CheckKey,
  now: number
): boolean {
  if (check === "compromised") return Boolean(row.compromised);
  if (check === "weak") return Boolean(row.weak);
  if (check === "reused") return Boolean(row.reused);
  if (check === "http") return isUnsecuredAddress(row);
  if (check === "age") return isPasswordStale(row, now);
  return isExpiringSoon(row, now);
}

export function rowsFor(
  rows: readonly LockerRow[],
  filter: ItemFilter
): LockerRow[] {
  const now = Date.now();
  const pool = rows.filter((row) => {
    if (filter.kind === "starred") return Boolean(row.favorite);
    if (filter.kind === "review") return needsReview(row);
    if (filter.kind === "verdict") return matchesCheck(row, filter.check, now);
    if (filter.kind === "type") return row.type === filter.type;
    if (filter.kind === "tag") return (row.tags ?? []).includes(filter.tag);
    return true;
  });
  return [...pool].sort(byTitle);
}

export function typeCounts(
  rows: readonly LockerRow[]
): Record<LockerItemType, number> {
  const counts = Object.fromEntries(
    TYPE_ORDER.map((type) => [type, 0])
  ) as Record<LockerItemType, number>;
  for (const row of rows) {
    if (row.type in counts) counts[row.type] += 1;
  }
  return counts;
}

export function tagCounts(
  rows: readonly LockerRow[]
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function windowEndCopy(
  shown: number,
  truncated: boolean,
  total?: number | null
): string {
  if (typeof total === "number" && Number.isFinite(total)) {
    return `${shown} of ${total} · ${WINDOW_RULE}`;
  }
  return truncated
    ? `${shown} shown, and older items beyond them · ${WINDOW_RULE}`
    : `${shown} in the vault · ${WINDOW_RULE}`;
}

export function showsWindowEnd(loaded: boolean, shown: number): boolean {
  return loaded && shown > 0;
}

export function clockAt(iso: string): string {
  return iso.slice(11, 16);
}

export { purgeCountdown } from "../_shared/format-kit.ts";

export function isQueued(row: LockerRow): boolean {
  const status = readPendingOverlay(
    row as unknown as Record<string, unknown>
  )?.status;
  return status === "queued" || status === "sending";
}

export function isConflicted(row: LockerRow): boolean {
  return (
    readPendingOverlay(row as unknown as Record<string, unknown>)?.status ===
    "conflict"
  );
}

export function isParked(row: LockerRow): boolean {
  return (
    readPendingOverlay(row as unknown as Record<string, unknown>)?.status ===
    "parked"
  );
}

export const OPEN_ITEM = "item";

export function primarySealedField(type: LockerItemType | string): string {
  if (type === "card") return "card_number";
  if (type === "note") return "content";
  if (type === "identity") return OPEN_ITEM;
  return "password";
}

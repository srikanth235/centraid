// PURE PROJECTIONS OF A ROW (README-Locker §5, "Item row").
//
// No app state, no vault IO, no JSX: every function is a plain function of its
// arguments, so every list composes the SAME row from the same three
// derivations — a title, a meta sentence, and at most one verdict.

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

/** The type chip's two letters — a micro-rung mark, never a lock icon standing
 *  in for a sentence (§7). Derived from the type's own label so a type the
 *  vault gains later needs no second table. */
export function typeChip(type: LockerItemType): string {
  return (TYPE_LABEL[type] ?? "Item").slice(0, 2).toUpperCase();
}

/** The type's word. An unknown discriminant degrades to "Item" rather than to
 *  nothing (README-Locker §3: a type the vault does not have yet degrades). */
export function typeLabel(type: LockerItemType | string): string {
  return TYPE_LABEL[type as LockerItemType] ?? "Item";
}

/**
 * The row's meta sentence: type · username · address · tags.
 *
 * The list payload carries `subtitle` — the query's own secret-free rendering
 * of whichever field identifies this type (a username, a card's last four, a
 * network name) — so the sentence reads it rather than re-deriving one the
 * server already decided. Empty parts are dropped, never drawn as an em dash.
 */
export function metaSentence(row: LockerRow): string {
  const tags = (row.tags ?? []).map((tag) => `#${tag}`).join(" ");
  return [typeLabel(row.type), row.subtitle, tags]
    .filter((part): part is string => Boolean(part) && part !== "—")
    .map((part) => displayText(part))
    .join("  ·  ");
}

/**
 * The row's ONE verdict chip, or null.
 *
 * Compromised outranks the rest and is the only one that takes `--net`: it is
 * the verdict with a consequence outside this device. Weak and reused are
 * "not yet, and not wrong", which is the seam.
 */
export function verdictOf(row: LockerRow): Verdict | null {
  if (row.compromised) return { label: "COMPROMISED", tone: "net" };
  if (row.reused) return { label: "REUSED", tone: "seam" };
  if (row.weak) return { label: "WEAK", tone: "seam" };
  return null;
}

/** Rows by title, the order every list in this app uses. */
export function byTitle(a: LockerRow, b: LockerRow): number {
  return String(a.title ?? "").localeCompare(String(b.title ?? ""));
}

/** Does this row carry any verdict at all? The Review route's own membership. */
export function needsReview(row: LockerRow): boolean {
  return Boolean(row.compromised || row.reused || row.weak);
}

// ---------------------------------------------------------------------------
// The five checks, as row predicates
// ---------------------------------------------------------------------------

/** A card expiry inside this many days is a verdict (GAPS §3.3 #6b). */
export const EXPIRY_HORIZON_DAYS = 90;

/** An address a page would be served over http, and Review says so. A bare
 *  host with no scheme is NOT this: unknown is not insecure. */
export function isUnsecuredAddress(row: LockerRow): boolean {
  return /^http:\/\//iu.test(String(row.url ?? ""));
}

/**
 * Whole days until a card expires, or `null` where the stored value is not a
 * date this seat can read. `MM / YY`, `MM/YYYY` and `YYYY-MM` all parse; an
 * expiry is the END of its month, which is when the card actually stops.
 */
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
  // The first instant of the month AFTER the one printed on the card — a card
  // is good through the last day of its stated month.
  const end = Date.UTC(year, month, 1);
  return Math.ceil((end - now) / DAY_MS);
}

export function isExpiringSoon(row: LockerRow, now: number): boolean {
  if (row.type !== "card") return false;
  const days = daysUntilExpiry(row.expiry, now);
  return days !== null && days <= EXPIRY_HORIZON_DAYS;
}

/** A password older than this is a verdict (GAPS §3.3 #6d). A year, because
 *  that is the horizon the copy states — the number and the sentence are one
 *  fact, and neither may move without the other. */
export const PASSWORD_AGE_HORIZON_DAYS = 365;

/** Has this item's CURRENT password stood longer than the horizon? A row with
 *  no `password_set_at` is NOT old — it is a row the vault never dated, and
 *  calling it stale would be a verdict nobody earned. */
export function isPasswordStale(row: LockerRow, now: number): boolean {
  if (!row.password_set_at) return false;
  const set = new Date(row.password_set_at).getTime();
  if (Number.isNaN(set)) return false;
  return (now - set) / DAY_MS > PASSWORD_AGE_HORIZON_DAYS;
}

/** Does this row hold THIS verdict? The one derivation Review's registers and
 *  the list's verdict lens both read, so pressing *Show them* can never open
 *  a lens over a different set from the count that was pressed. */
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

/** The rows one filter shows, sorted. Pure, so the rail's counts and the list
 *  itself cannot disagree about what "Starred" means. */
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
    // The archived shelf is a different READ, not a different slice: the rows
    // in hand are already the archived ones, so filtering them again here
    // would be asking the same question twice and risking two answers.
    return true;
  });
  return pool.toSorted(byTitle);
}

/** How many rows each type holds, for the rail's six rows. A zero is drawn as
 *  a zero: a type with nothing in it is a fact, not a row to hide. */
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

/** The tag vocabulary present in the window, with counts, alphabetical. */
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
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * THE BOUNDED WINDOW'S OWN FOOT (README-Locker §6, "Window end").
 *
 * `300 of 312 · the window is 300 by default and 2,000 at most.` — the §6
 * sentence, whole, whenever the `items` payload carries the live `total` the
 * vault counted for it.
 *
 * AND THE FALLBACK IS NOT DECORATION. `total` is ABSENT when the count could
 * not be read, and a denominator this seat does not have is one it will not
 * invent: it then says how many it is showing, and that older items exist
 * beyond them, which is the whole of what it knows.
 */
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

/** Should the window's foot be drawn at all? Only over a landed read with rows
 *  in it — a foot under an empty list is a claim about a set nobody read. */
export function showsWindowEnd(loaded: boolean, shown: number): boolean {
  return loaded && shown > 0;
}

/** Wall-clock hours and minutes, for the stale notice's "last matched at". */
export function clockAt(iso: string): string {
  return iso.slice(11, 16);
}

// THE TRASH ROW'S OWN CLOCK is the format kit's (#883 B4): Docs' drive and
// Locker's trash printed the same sentence character for character, because a
// member should not have to learn two ways of reading "how long have I got".
// Re-exported here because Locker's Trash component and the phone's Locker
// trash screen both reach for it through this module's path.
export { purgeCountdown } from "../_shared/format-kit.ts";

// ---------------------------------------------------------------------------
// What a held write on a row means
// ---------------------------------------------------------------------------

/**
 * Three different facts the shared overlay engine can put on a row, and they
 * are asked separately because they lead to three different notices.
 *
 * `queued` is a write still on this device waiting for a connection — which in
 * Locker is ALWAYS metadata, because a secret write refuses to queue at all
 * (`writes.ts`). `parked` and `conflict` are decisions, not delays: one is
 * waiting on the owner, the other on the member.
 */
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

/**
 * THE FIELD A PERMIT IS MINTED FOR WHEN AN ITEM IS OPENED.
 *
 * Opening an item is itself a per-item gesture — the `item` query is the one
 * secret-bearing read and it takes an item token — so the gate has to name
 * SOMETHING. It names the field this type actually seals, rather than assuming
 * every item is a login: asking a card for its password would mint a permit
 * against a field the item does not have and then reveal nothing, which reads
 * to the member as a refusal that was not one.
 *
 * `OPEN_ITEM` is the honest answer for a type that seals nothing: the read is
 * what is being authorised, and the gate says so.
 */
export const OPEN_ITEM = "item";

export function primarySealedField(type: LockerItemType | string): string {
  if (type === "card") return "card_number";
  if (type === "note") return "content";
  if (type === "identity") return OPEN_ITEM;
  return "password";
}

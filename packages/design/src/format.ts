/** Shared display formatters used by shell and native clients. */

export function formatRelativeTime(
  value: string | number | undefined,
  now: number = Date.now()
): string {
  if (value === undefined) return "Recently";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let size = value;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit] ?? "KB"}`;
}

/**
 * MINOR UNITS ARE NOT ALWAYS HUNDREDTHS (#1020, R-1020-35).
 *
 * ISO 4217 gives each currency an exponent, and it is 2 for most of them, 0
 * for the currencies with no subunit and 3 for the Gulf dinars. This function
 * divided by 100 unconditionally, so a ¥1,234 expense rendered as ¥12.34 — a
 * hundredfold error on a member's own money, in the direction that makes a
 * ledger look settled — and a 1.500 KWD one rendered as 15.00 KWD, ten times
 * too much.
 *
 * Only the exponents that are NOT 2 are listed; everything absent is 2. The
 * table is the currencies a vault can hold today plus the rest of each
 * exponent's ISO list, so a new currency code does not silently get the wrong
 * scale — it gets the common one.
 */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  // Exponent 0 — no subunit at all.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Exponent 3 — thousandths.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** ISO 4217's minor-unit exponent for a currency; 2 for anything unlisted. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/**
 * THE FORMATTER'S LOCALE IS AN ARGUMENT, NEVER THE HOST'S (#1020, R-1020-35).
 *
 * Passing `undefined` to `Intl.NumberFormat` means "whatever this device is
 * set to", so one vault rendered the same row differently on a phone and a
 * desktop, and a fixture's bytes depended on the machine that generated them.
 * A vault-held display locale is the right source and there is none in the
 * tree today (`grep -rn 'locale:' packages/{client,core,design}/src` finds
 * nothing but `localeCompare`), so the default is stated rather than inherited
 * and the gap is a finding rather than a silent host read.
 */
export const DEFAULT_LOCALE = "en-US";

/** Minor units → localized currency; Expo-reachable (same contract as client). */
export function fmtMoney(
  minor: number | null | undefined,
  currency?: string,
  locale: string = DEFAULT_LOCALE
): string {
  const code =
    typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? currency.toUpperCase()
      : "USD";
  const exponent = minorUnitExponent(code);
  const value = Number(minor ?? 0) / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(exponent)} ${code}`.trim();
  }
}

/**
 * The viewer's local YYYY-MM-DD for an instant — never the UTC slice.
 *
 * Lives in the token layer (Expo-reachable) rather than
 * `@centraid/design/elements`, which has no `react-native` condition and
 * resolves only through `dist/`. `timeZone` is an IANA name; omit it for the
 * host zone.
 */
export function localDayKey(
  dateish: string | number | Date,
  timeZone?: string
): string {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return String(dateish).slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return String(dateish).slice(0, 10);
  return `${year}-${month}-${day}`;
}

/**
 * How a figure leaf is painted. `net` is the `--net` token — you owe; `owed`
 * is plain ink — you are owed; `settled` is the recessive rung. NEVER a green:
 * a settled balance is a fact, not a reward.
 */
export type FigureTone = "net" | "owed" | "settled";

/**
 * A net's tone, on Tally's one sign convention: **positive is owed to you,
 * negative is owed by you**, so a figure never needs a legend.
 *
 * The dead band is a single minor unit — a balance that rounds to nothing IS
 * level, and a row reading "you owe £0.00" in `--net` would be a warning about
 * nothing.
 *
 * IT LIVES HERE, IN THE TOKEN PACKAGE, BECAUSE IT IS A TOKEN DECISION. It was
 * written in `packages/blueprints/apps/tally/format.ts` beside Tally's other
 * formatters, and wave 6 retired that tree (#1020); the rule itself did not
 * retire, because `crates/design`'s `figure_tone` is its port and
 * `contracts/tools/export-design-corpus.ts` runs THIS function over 252 rows to
 * produce the corpus `crates/design/tests/corpus.rs` asserts against. Choosing
 * which of three prominence rungs a number takes is the same kind of decision
 * as choosing the rung itself, so `packages/design` is where it belongs.
 */
export function figureTone(netMinor: number): FigureTone {
  if (Math.abs(netMinor) < 1) return "settled";
  return netMinor < 0 ? "net" : "owed";
}

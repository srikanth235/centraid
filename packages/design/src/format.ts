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

/** ISO 4217 exponents differing from the default 2 (#1020, R-1020-35). */
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

/** Unlisted currencies use exponent 2. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Explicit locale keeps output deterministic; no vault display locale exists yet (#1020). */
export const DEFAULT_LOCALE = "en-US";

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

/** Viewer-local day; optional IANA timeZone defaults to the host zone. */
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

/** net: owed by you; owed: plain ink; settled: recessive, never green. */
export type FigureTone = "net" | "owed" | "settled";

/** Positive means owed to you; a one-minor-unit dead band is settled. Corpus-backed Rust parity (#1020). */
export function figureTone(netMinor: number): FigureTone {
  if (Math.abs(netMinor) < 1) return "settled";
  return netMinor < 0 ? "net" : "owed";
}

// App-facing formatters. Each one lowers a shared contract from the token
// layer (`../format.js`, `../identity.js`) into the shape blueprint app code
// asks for — an empty string rather than a placeholder, minor units rather
// than a float, the viewer's local day rather than the UTC slice.

import { formatBytes, formatRelativeTime } from "../format.js";

export { localDayKey } from "../format.js";

/** Minor units → localized currency string ("€12.34"), tolerant of gaps. */
export function fmtMoney(
  minor: number | null | undefined,
  currency?: string
): string {
  // Keep the same contract as @centraid/client formatCurrencyMinor so web
  // Home, Tally, and Capture never diverge on invalid ISO codes.
  const value = Number(minor ?? 0) / 100;
  const code =
    typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? currency.toUpperCase()
      : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`.trim();
  }
}

/** "5m" / "3h" / "2d" — the notifications-style relative timestamp. */
export function relTime(iso: string): string {
  const label = formatRelativeTime(iso);
  return label === "Recently" ? "" : label;
}

/** "812 B" / "24 KB" / "1.3 MB" — `empty` is returned for 0/absent sizes. */
export function fmtBytes(n: number | null | undefined, empty = ""): string {
  if (!n || !Number.isFinite(Number(n)) || n < 0) return empty;
  return formatBytes(n);
}

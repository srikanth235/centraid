// App-facing formatters. Each one lowers a shared contract from the token
// layer (`../format.js`, `../identity.js`) into the shape blueprint app code
// asks for — an empty string rather than a placeholder, minor units rather
// than a float, the viewer's local day rather than the UTC slice.

import { formatBytes, formatRelativeTime } from "../format.js";

export { fmtMoney, localDayKey } from "../format.js";

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

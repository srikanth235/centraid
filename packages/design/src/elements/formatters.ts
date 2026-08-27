// App-facing formatters: token-layer contracts in the shape blueprint code asks for.

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

import { formatBytes, formatRelativeTime } from "../format.js";

export { fmtMoney, localDayKey } from "../format.js";

export function relTime(iso: string): string {
  const label = formatRelativeTime(iso);
  return label === "Recently" ? "" : label;
}

export function fmtBytes(n: number | null | undefined, empty = ""): string {
  if (!n || !Number.isFinite(Number(n)) || n < 0) return empty;
  return formatBytes(n);
}

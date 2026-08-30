// No relative import: the client program has no `allowImportingTsExtensions`.
import { localDayKey } from "@centraid/design";

export const DAY_MS = 86_400_000;

export const MONTHS: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function plural(count: number, one: string, many?: string): string {
  return `${count} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

export interface FmtDayOptions {
  absolute?: Intl.DateTimeFormatOptions;
  locale?: Intl.LocalesArgument;
  undated?: string;
  now?: Date;
}

/** Compared on the LOCAL wall clock: an evening photograph is not tomorrow's. */
export function fmtDay(key: string, options: FmtDayOptions = {}): string {
  if (!key) return options.undated ?? "";
  const now = options.now ?? new Date();
  if (key === localDayKey(now)) return "Today";
  if (key === localDayKey(new Date(now.getTime() - DAY_MS))) return "Yesterday";
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(
      options.locale,
      options.absolute ?? { day: "numeric", month: "short", weekday: "short" }
    );
  } catch {
    return key;
  }
}

/** An unreadable date must never read "purges today". */
export function purgeCountdown(iso: string | null | undefined): string {
  if (!iso) return "";
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "purges today";
  if (days === 1) return "purges tomorrow";
  return `purges in ${days} days`;
}

/** Rounds, never truncates: truncation loses the last second. */
export function mediaClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

export type CustodyTone = "ok" | "warn" | "danger";

export interface CustodyMeta {
  label: string;
  tone: CustodyTone;
}

const CUSTODY_META: Readonly<Record<string, CustodyMeta>> = {
  "local-only": { label: "On this device only", tone: "warn" },
  missing: { label: "Missing — needs attention", tone: "danger" },
  // "warn", not "ok": a queued copy is not a copy.
  "pending-offsite": { label: "Copy queued, not finished", tone: "warn" },
  replicated: { label: "Backed up", tone: "ok" },
  "remote-only": { label: "Only in the cloud", tone: "warn" },
};

export function custodyMeta(
  state: string | null | undefined
): CustodyMeta | null {
  return CUSTODY_META[state ?? ""] ?? null;
}

/** The CSP blocks `fetch()` of a `data:` URI (#296); `null` means not inline. */
export function decodeDataUri(uri: string | null | undefined): string | null {
  const text = String(uri ?? "");
  if (!text.startsWith("data:")) return null;
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  const meta = text.slice(0, comma);
  const payload = text.slice(comma + 1);
  try {
    if (!meta.includes(";base64")) return decodeURIComponent(payload);
    // `atob` yields BYTES; reading them as characters mangles multi-byte text.
    const binary = globalThis.atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

/** The object URL is revoked at once: a Locker export points at plaintext. */
export function saveExportFile(file: {
  name: string;
  type: string;
  text: string;
}): void {
  const blob = new Blob([file.text], { type: `${file.type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

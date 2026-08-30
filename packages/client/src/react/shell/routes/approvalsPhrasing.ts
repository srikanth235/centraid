import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import type {
  NoticeRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
} from "../../screens/ApprovalsScreen.js";

/*
 * How Notifications SAYS things (#815) — pure, and out of the component.
 * Nothing here may reach back into the screen; hence the type-only import.
 */

function isEditableKey(
  artifact: Record<string, unknown>,
  key: string
): boolean {
  const v = artifact[key];
  return (
    typeof v === "string" ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}

/** Facts the ACTOR computed: as text, a card could misdescribe its own write. */
const COMPUTED_KEYS = new Set([
  "bytes",
  "checksum",
  "files",
  "schema",
  "size",
  "undo",
]);

export function isAuthorableKey(
  artifact: Record<string, unknown>,
  key: string
): boolean {
  const lower = key.toLowerCase();
  if (COMPUTED_KEYS.has(lower)) return false;
  if (lower.includes("count") || lower.endsWith("size")) return false;
  return isEditableKey(artifact, key);
}

export function wantsTextarea(key: string, value: string): boolean {
  return (
    key.toLowerCase().includes("body") ||
    value.includes("\n") ||
    value.length > 120
  );
}

/** Words, not a chip — the one chromatic ink means "leaves the device". */
export function callerPhrase(kind: string, caller: string): string {
  switch (kind) {
    case "app":
      return `the app ${caller}`;
    case "agent":
      return `the automation ${caller}`;
    case "assistant":
      return "the assistant";
    default:
      return caller;
  }
}

/** Never guesses past the verb and connection kind. */
export function outboundLabel(row: {
  verb: string;
  connectionKind: string;
}): string {
  const signal = `${row.verb} ${row.connectionKind}`.toLowerCase();
  if (signal.includes("mail") || signal.includes("smtp")) {
    return "Outbound email";
  }
  if (
    signal.includes("message") ||
    signal.includes("chat") ||
    signal.includes("slack") ||
    signal.includes("sms")
  ) {
    return "Outbound message";
  }
  return "Outbound write";
}

export function noticeSeverityLabel(
  kind: string,
  severity: NoticeRowDTO["severity"]
): string | null {
  if (severity === "info") return null;
  if (kind === "gateway-health")
    return severity === "high" ? "Down" : "Degraded";
  return severity === "high" ? "Failed" : "Warning";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function spanWords(ms: number): string {
  if (ms >= DAY_MS) {
    const d = Math.round(ms / DAY_MS);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (ms >= HOUR_MS) {
    const h = Math.round(ms / HOUR_MS);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** A day-plus run of failures reads as "failing for 6 days" (#647). */
export function noticeSpanPhrase(
  row: Pick<NoticeRowDTO, "count" | "firstAt" | "lastAt" | "severity">
): string | null {
  if (row.count <= 1) return null;
  const first = Date.parse(row.firstAt);
  const last = Date.parse(row.lastAt);
  // Never invent a duration.
  if (Number.isNaN(first) || Number.isNaN(last) || last <= first) {
    return `×${row.count}`;
  }
  const span = last - first;
  if (row.severity !== "info" && span >= DAY_MS) {
    return `failing for ${spanWords(span)}`;
  }
  return `×${row.count} over ${spanWords(span)}`;
}

export function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function decisionWord(decision: string): string {
  switch (decision) {
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "parked":
      return "Parked";
    default:
      return decision;
  }
}

export function subLine(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(" · ");
}

export interface Blocking {
  outbox: readonly ApprovalsOutboxRowDTO[];
  needsAuth: readonly ApprovalsNeedsAuthRowDTO[];
  parked: readonly ApprovalsParkedRowDTO[];
  scopeRequests: readonly ApprovalsScopeRequestRowDTO[];
}

export function blockingIds(lists: Blocking): Set<string> {
  return new Set([
    ...lists.outbox.map((r) => r.itemId),
    ...lists.needsAuth.map((r) => r.connectionId),
    ...lists.parked.map((r) => r.invocationId),
    ...lists.scopeRequests.map((r) => r.requestId),
  ]);
}

export function arrivalCount(shown: Blocking, next: Blocking): number {
  const seen = blockingIds(shown);
  let arrived = 0;
  for (const id of blockingIds(next)) if (!seen.has(id)) arrived += 1;
  return arrived;
}

export const WAITING_CHIPS = [
  { id: "all", label: "Everything" },
  { id: "risk", label: "High risk" },
  { id: "auth", label: "Authorization" },
  { id: "staged", label: "Staged writes" },
] as const;

export type WaitingFilter = (typeof WAITING_CHIPS)[number]["id"];

/** One kind, one chip — two matches make "showing 3 of 12" a lie. */
type WaitingKind = "staged" | "auth" | "risk";

export function matchesFilter(
  filter: WaitingFilter,
  kind: WaitingKind
): boolean {
  return filter === "all" || filter === kind;
}

export type RecordSection = "grants" | "ledger" | "egress" | "activity";

/** One at a time: two open confirms ask two questions at once. */
export interface Confirming {
  id: string;
  verb:
    | "discard"
    | "deny-parked"
    | "deny-scope"
    | "revoke-grant"
    | "revoke-holder";
}

/** Open under a pointer, closed on touch. Resolved ONCE at mount:
 *  re-resolving would close a section a member had just opened. */
export function pointerDefaultOpen(): boolean {
  if (typeof matchMedia !== "function") return true;
  return matchMedia("(pointer: fine)").matches;
}

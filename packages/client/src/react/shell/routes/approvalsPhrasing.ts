import type {
  NoticeRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
} from "../../screens/ApprovalsScreen.js";

/*
 * How Notifications SAYS things (#815).
 *
 * The screen's presentation rules, beside the DTO builders that feed them and
 * out of the component that renders them: which artifact fields a member may
 * author, who staged a write in English, what a collapsed run of failures is
 * called, and what counts as an arrival when a refresh lands. Every one is
 * pure, so each is testable without a DOM — and none of them may reach back
 * into the screen, which is why the type import above is type-only.
 */

/** `artifact[key]` is editable (string or a list of strings) — the shape the
 *  gateway's shape-drift guard accepts. */
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

/** Facts the ACTOR computed, never the member: a size, a file count, an undo
 *  window. They are stated, because a computed fact offered as text lets an
 *  approved card misdescribe the write it approved. */
const COMPUTED_KEYS = new Set([
  "bytes",
  "checksum",
  "files",
  "schema",
  "size",
  "undo",
]);

/** Can a member AUTHOR this field — is it both an editable shape and a value
 *  they wrote rather than one the actor derived? */
export function isAuthorableKey(
  artifact: Record<string, unknown>,
  key: string
): boolean {
  const lower = key.toLowerCase();
  if (COMPUTED_KEYS.has(lower)) return false;
  if (lower.includes("count") || lower.endsWith("size")) return false;
  return isEditableKey(artifact, key);
}

/** A textarea reads better than a single-line input for body-like or already
 *  multi-line text. */
export function wantsTextarea(key: string, value: string): boolean {
  return (
    key.toLowerCase().includes("body") ||
    value.includes("\n") ||
    value.length > 120
  );
}

/**
 * WHO staged or asked, as words rather than a coloured chip. A kind badge
 * would be a classifier pill in a system whose one chromatic ink means "this
 * leaves the device"; the same fact reads better as English in the line that
 * already names the actor.
 */
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

/**
 * What KIND of outbound write this is, from the connection and verb the
 * gateway staged it under. Never guesses beyond what those two say: an
 * unrecognised verb is "Outbound write", which is true of every item here.
 */
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

/**
 * Severity as a WORD, not a coloured rail. `info` gets nothing: a quiet update
 * needs no label.
 */
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
const DAY_MS = 24 * HOUR_MS;

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

/**
 * Collapsed-notice duration phrase (#647). A day-plus run of failures reads as
 * "failing for 6 days" — the thing the owner actually needs to know; anything
 * shorter, or merely informational, keeps the neutral "×6 over 3 hours".
 * Returns null for an uncollapsed notice (count 1), which has no span to tell.
 */
export function noticeSpanPhrase(
  row: Pick<NoticeRowDTO, "count" | "firstAt" | "lastAt" | "severity">
): string | null {
  if (row.count <= 1) return null;
  const first = Date.parse(row.firstAt);
  const last = Date.parse(row.lastAt);
  // Unparseable or non-advancing timestamps: state the multiplicity only,
  // never invent a duration.
  if (Number.isNaN(first) || Number.isNaN(last) || last <= first) {
    return `×${row.count}`;
  }
  const span = last - first;
  if (row.severity !== "info" && span >= DAY_MS) {
    return `failing for ${spanWords(span)}`;
  }
  return `×${row.count} over ${spanWords(span)}`;
}

/** Absolute local timestamp for the expanded activity detail (#552). */
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

/** Decision → the row's one state word (#552). */
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

/** Join the parts of a sub line, dropping the ones with nothing to say — a sub
 *  that renders " ·  · yesterday" is a bug that reads as a typo. */
export function subLine(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(" · ");
}

/** The blocking lists, as one value — what the held tray freezes. */
export interface Blocking {
  outbox: readonly ApprovalsOutboxRowDTO[];
  needsAuth: readonly ApprovalsNeedsAuthRowDTO[];
  parked: readonly ApprovalsParkedRowDTO[];
  scopeRequests: readonly ApprovalsScopeRequestRowDTO[];
}

/** Every blocking id, in one set — the identity a refresh is compared on. */
export function blockingIds(lists: Blocking): Set<string> {
  return new Set([
    ...lists.outbox.map((r) => r.itemId),
    ...lists.needsAuth.map((r) => r.connectionId),
    ...lists.parked.map((r) => r.invocationId),
    ...lists.scopeRequests.map((r) => r.requestId),
  ]);
}

/** How many of `next` are not in `shown` — the tray's count. */
export function arrivalCount(shown: Blocking, next: Blocking): number {
  const seen = blockingIds(shown);
  let arrived = 0;
  for (const id of blockingIds(next)) if (!seen.has(id)) arrived += 1;
  return arrived;
}

/** The waiting-queue filter, shown only when the queue is full enough to need
 *  one. Ids are the v9 chip set; the labels are its copy. */
export const WAITING_CHIPS = [
  { id: "all", label: "Everything" },
  { id: "risk", label: "High risk" },
  { id: "auth", label: "Authorization" },
  { id: "staged", label: "Staged writes" },
] as const;

export type WaitingFilter = (typeof WAITING_CHIPS)[number]["id"];

/** Which chip a waiting item answers to. One kind, one chip — an item that
 *  matched two would make "showing 3 of 12" a lie in one of them. */
type WaitingKind = "staged" | "auth" | "risk";

export function matchesFilter(
  filter: WaitingFilter,
  kind: WaitingKind
): boolean {
  return filter === "all" || filter === kind;
}

/** The four sections of the record, each of which opens and closes. */
export type RecordSection = "grants" | "ledger" | "egress" | "activity";

/** Which irreversible verb is being confirmed, and on what. One at a time: a
 *  page with two open confirms is a page asking two questions at once. */
export interface Confirming {
  id: string;
  verb:
    | "discard"
    | "deny-parked"
    | "deny-scope"
    | "revoke-grant"
    | "revoke-holder";
}

// ── Small honest phrasings ────────────────────────────────────────────────

/**
 * Are the record sections open to begin with? Open under a pointer, closed on
 * touch, where four expanded reference sections are a page a thumb has to
 * scroll past to reach the decision it came for. Resolved ONCE at mount: a
 * media query cannot drive a JS default, and re-resolving it later would close
 * a section a member had just opened.
 */
export function pointerDefaultOpen(): boolean {
  if (typeof matchMedia !== "function") return true;
  return matchMedia("(pointer: fine)").matches;
}

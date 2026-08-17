import { relativeTime } from "../../../app-format.js";
import { APPROVALS_HEALTH_DETAIL } from "../../../approvals-copy.js";
import type { EnrichConsentRecord } from "../../../enrich-policy.js";
import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
  ReviewEntry,
} from "../../../gateway-client-outbox.js";
import type { VaultParkedEntry } from "../../../gateway-client-vault.js";
import type {
  ApprovalsEnrichConsentRowDTO,
  NoticeRowDTO,
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
  ApprovalsActivityRowDTO,
} from "../../screens/ApprovalsScreen.js";

// ── What the frame says about this page (issue #765) ──────────────────────
// The count line under the title, the state that decides which verbs the bar
// offers, and the one persistent status sentence. They live here, beside the
// DTO builders, because all three are derived from the same fetch the builders
// map — a screen that computed them separately could disagree with the bar it
// is rendering under.

/** What the page has to say about, counted. */
export interface ApprovalsTally {
  /** Decisions plus the notices that are a demand rather than news. */
  waiting: number;
  /** Standing grants still in force. */
  grants: number;
}

/**
 * Above this many waiting items the queue stops being scannable and earns its
 * filter chips. It is the `full` state — not a different page, just the same
 * one admitting it is long.
 */
export const APPROVALS_FULL_AT = 4;

export function approvalsState(
  tally: ApprovalsTally
): "ready" | "full" | "empty" {
  if (tally.waiting === 0) return "empty";
  return tally.waiting > APPROVALS_FULL_AT ? "full" : "ready";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The app bar's count line. Empty says what is still true, not what is
 *  missing — there is no zero here, only "nothing waiting". */
export function approvalsCountLine(tally: ApprovalsTally): string {
  const standing = plural(tally.grants, "standing grant", "standing grants");
  if (tally.waiting === 0) return `Nothing waiting · ${standing}`;
  return `${plural(tally.waiting, "decision waiting", "decisions waiting")} · ${standing}`;
}

/**
 * The status line in ready/full. No inline action: every verb this page offers
 * is attached to the thing it acts on, and a status line that offered a
 * shortcut past that would be offering to decide for you.
 */
export function approvalsHealth(tally: ApprovalsTally): {
  label: string;
  detail: string;
} {
  return {
    detail: APPROVALS_HEALTH_DETAIL,
    label: `${tally.waiting} waiting on you`,
  };
}

/** Titlecase a snake/dot-separated key for the detail panel's field labels. */
function labelFor(key: string): string {
  return key.replace(/[_.]/gu, " ").replace(/\b\w/gu, (c) => c.toUpperCase());
}

/** Render one artifact value readably — arrays join, objects pretty-print. */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * `artifact.to` is a recipient address, or a list of them (the gmail-send
 * template's real shape is an array; its own test fixture uses a bare
 * string) — join defensively rather than assume one or the other.
 */
function recipientFrom(
  artifact: Record<string, unknown>,
  fallbackTarget: string
): string {
  const to = artifact.to;
  if (typeof to === "string" && to.length > 0) return to;
  if (Array.isArray(to) && to.length > 0) return to.map(String).join(", ");
  return fallbackTarget;
}

/** Map one wire `OutboxItem` to the screen's row DTO. */
export function buildOutboxRow(item: OutboxItem): ApprovalsOutboxRowDTO {
  const artifact = item.artifact ?? {};
  const subject =
    typeof artifact.subject === "string" ? artifact.subject : null;
  const body = typeof artifact.body === "string" ? artifact.body : null;
  const fields = Object.entries(artifact).map(([key, value]) => ({
    key,
    label: labelFor(key),
    value: fieldValue(value),
  }));
  return {
    itemId: item.itemId,
    connectionLabel: item.connection.label,
    connectionKind: item.connection.kind,
    verb: item.verb,
    target: item.target,
    recipient: recipientFrom(artifact, item.target),
    subject,
    bodyPreview: body
      ? body.length > 160
        ? `${body.slice(0, 160)}…`
        : body
      : null,
    fields,
    stagedAgo: relativeTime(item.stagedAt),
    note: item.note,
    canEdit: item.canEdit,
    artifact,
    caller: item.actor ?? item.actorKind,
    callerKind: item.actorKind,
  };
}

export function buildNeedsAuthRow(
  row: OutboxNeedsAuth
): ApprovalsNeedsAuthRowDTO {
  return {
    connectionId: row.connectionId,
    label: row.label,
    kind: row.kind,
    note: row.note,
  };
}

export function buildParkedRow(row: VaultParkedEntry): ApprovalsParkedRowDTO {
  return {
    invocationId: row.invocationId,
    command: row.command,
    caller: row.caller ?? row.callerKind,
    callerKind: row.callerKind,
    parkedAgo: relativeTime(row.parkedAt),
    inputPreview: JSON.stringify(row.input, null, 2),
  };
}

function scopeSummary(scopes: OutboxScopeRequest["scopes"]): string {
  return scopes
    .map((s) => {
      const extent = [
        s.rowFilter ? `${s.rowFilter.length} row rule` : "",
        s.fieldMask ? `${s.fieldMask.length} fields` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `${s.schema}${s.table ? `.${s.table}` : ""} (${s.verbs}${
        extent ? ` · ${extent}` : ""
      })`;
    })
    .join(", ");
}

export function buildScopeRequestRow(
  row: OutboxScopeRequest
): ApprovalsScopeRequestRowDTO {
  return {
    requestId: row.requestId,
    appId: row.appId,
    purpose: row.purpose,
    scopeSummary: scopeSummary(row.scopes),
    requestedAgo: relativeTime(row.requestedAt),
  };
}

export function buildGrantRow(row: OutboxGrant): ApprovalsGrantRowDTO {
  return {
    grantId: row.grantId,
    actorLabel: row.actor ?? row.actorId,
    verb: row.verb,
    target: row.target,
    createdAgo: relativeTime(row.createdAt),
  };
}

/**
 * Humanize a review-feed verb for the activity row label (issue #552).
 * Locker reveal/fill copy is special-cased; everything else strips the
 * `act ` prefix and sentence-cases separators so unmapped verbs still read
 * as English (`act sync.remove_connection` → `Sync remove connection`).
 */
export function humanizeActivityLabel(
  action: string,
  decision: string,
  objectType: string,
  context: ReviewEntry["context"]
): string {
  const isLockerReveal = action === "reveal" && objectType === "locker.item";
  const fillContext = context?.kind === "fill" ? context : undefined;
  const isFill = isLockerReveal && fillContext !== undefined;
  if (isFill) {
    return decision === "allow"
      ? "Locker filled a login"
      : "Locker fill denied";
  }
  if (isLockerReveal) {
    return decision === "allow"
      ? "Locker login revealed"
      : "Locker reveal denied";
  }
  const bare = action.startsWith("act ") ? action.slice(4) : action;
  const spaced = bare.replace(/[._]+/gu, " ").trim();
  if (spaced.length === 0) return action;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Truncate a long object id for the compact detail line. */
export function truncateObjectId(id: string, max = 12): string {
  if (id.length <= max) return id;
  return `${id.slice(0, Math.max(4, max - 1))}…`;
}

/**
 * Compact detail for an activity row: fill origin, or
 * `objectType · truncatedObjectId` when an id is present, else objectType.
 */
export function formatActivityDetail(
  objectType: string,
  objectId: string | null,
  context: ReviewEntry["context"],
  action: string
): string {
  const isLockerReveal = action === "reveal" && objectType === "locker.item";
  const fillContext = context?.kind === "fill" ? context : undefined;
  if (isLockerReveal && fillContext) return fillContext.origin;
  if (objectId) return `${objectType} · ${truncateObjectId(objectId)}`;
  return objectType;
}

/** Map one wire `ReviewEntry` to the screen's activity row DTO (issue #552). */
export function buildActivityRow(row: ReviewEntry): ApprovalsActivityRowDTO {
  const label = humanizeActivityLabel(
    row.action,
    row.decision,
    row.objectType,
    row.context
  );
  const detail = formatActivityDetail(
    row.objectType,
    row.objectId,
    row.context,
    row.action
  );
  const attribution: ApprovalsActivityRowDTO["attribution"] =
    row.grantId != null && row.grantId.length > 0
      ? "grant"
      : row.decision === "allow"
        ? "owner"
        : null;
  return {
    receiptId: row.receiptId,
    label,
    detail,
    objectId: row.objectId,
    objectType: row.objectType,
    occurredAgo: relativeTime(row.occurredAt),
    occurredAt: row.occurredAt,
    decision: row.decision,
    risk: row.risk,
    actor: row.actor ?? row.actorKind,
    actorKind: row.actorKind,
    grantId: row.grantId,
    attribution,
    count: 1,
    action: row.action,
  };
}

/**
 * Collapse adjacent consecutive activity rows that share verb + object +
 * decision into one row with a `×N` marker (issue #552). Non-adjacent
 * repeats do not collapse. Pure adjacency — no time window.
 */
export function collapseAdjacentActivity(
  rows: readonly ApprovalsActivityRowDTO[]
): ApprovalsActivityRowDTO[] {
  if (rows.length === 0) return [];
  const out: ApprovalsActivityRowDTO[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.action === row.action &&
      prev.objectType === row.objectType &&
      prev.objectId === row.objectId &&
      prev.decision === row.decision
    ) {
      out[out.length - 1] = { ...prev, count: prev.count + 1 };
    } else {
      out.push({ ...row, count: 1 });
    }
  }
  return out;
}

/*
 * The egress-consent ledger's rows (issue #807, Wave 3).
 *
 * The Privacy page reads the vault's answers back; it does not re-ask them.
 * So this maps a stored answer to words and nothing else: no "revoke" verb, no
 * inferred state, and a declined answer rendered exactly as plainly as a
 * granted one — a consent surface that hid its refusals would be a record of
 * only the yeses.
 */

/** What each egress class means where a member reads it. */
const EGRESS_PHRASE: Record<EnrichConsentRecord["egress"], string> = {
  "on-device": "on this device",
  gateway: "on your gateway",
  provider: "at a third-party provider",
};

/** The capability id as a sentence-cased label — the same treatment activity
 *  rows give an unmapped verb, so a capability this build never heard of still
 *  reads as English. */
export function enrichCapabilityLabel(capability: string): string {
  const spaced = capability.replace(/[._-]+/gu, " ").trim();
  if (spaced.length === 0) return capability;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Map one wire `EnrichConsentRecord` to the screen's row DTO. */
export function buildEnrichConsentRow(
  record: EnrichConsentRecord
): ApprovalsEnrichConsentRowDTO {
  const answer = record.decision === "granted" ? "Granted" : "Declined";
  const where = EGRESS_PHRASE[record.egress];
  const scope =
    record.scopeRef.length > 0 ? ` · ${record.scopeRef}` : " · this vault";
  return {
    id: `${record.capability}:${record.egress}:${record.scopeRef}`,
    meta: record.egress,
    sub: `${answer} · ${where}${scope} · ${relativeTime(record.decidedAt)}`,
    title: enrichCapabilityLabel(record.capability),
  };
}

/*
 * ── How Notifications SAYS things (#815) ─────────────────────────────────
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
 * WHO staged or asked, as words rather than a coloured chip. The kind badge
 * was a classifier pill in a system whose one chromatic ink means "this leaves
 * the device"; the same fact reads better as English in the line that already
 * names the actor.
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

/** Absolute local timestamp for the expanded activity detail (issue #552). */
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

/** Decision → the row's one state word (issue #552). */
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

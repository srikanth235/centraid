// What the Notifications place SAYS (#765, spec §2). Pure: no React, no
// gateway, no renderer — every word a block carries is decided here, so the
// copy contract is under test without mounting anything. Same split as
// `kit/components/health-line.ts` and `screens/connectors/connectors-model.ts`.
//
// The reference's rows are sample data; the sentences that state a RULE are
// verbatim, because they are the product's promises about what a decision
// does. A promise that drifts between two surfaces is a promise broken on one
// of them — so the desktop screen (`packages/client/.../ApprovalsScreen.tsx`)
// and this file carry the same strings, deliberately duplicated rather than
// shared: `packages/client` is a browser bundle this app does not import.
//
// THREE MISMATCHES BETWEEN THE REFERENCE AND THE PRODUCT, resolved the way
// desktop resolved them:
//
//  1. KIND BADGES BECOME WORDS. The prototype paints a coloured pill per kind.
//     In a system whose one chromatic ink means "this leaves the device", a
//     classifier pill would spend colour on taxonomy; the same fact reads
//     better as English in the line that already names the actor
//     (`callerPhrase`), with the row's one state word (`Staged`, `Lapsed`,
//     `High risk`, `New scope`) carrying the rest.
//  2. NOTICES FOLD INTO THE QUEUE. The old phone screen had a source-type
//     filter (Automations / Agents / Apps / Archived) over a flat notice list.
//     A notice that demands something (warning/high) is a thing waiting on
//     you, so it becomes an "Also waiting" row; an info notice is news, so it
//     sits under `Updates`; archived ones keep their own section. Nothing is
//     unreachable — what changed is that the queue narrows by what a thing
//     NEEDS rather than by who filed it.
//  3. BUSY WITHDRAWS THE VERB. A control mid-flight is not disabled-and-still-
//     inviting; the verb is taken away until the write lands, so a second tap
//     cannot stage a second decision.

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { PanelFact } from "../../kit/components/PanelBlock";
import type { RowsBlockAction } from "../../kit/components/RowsBlock";
import { describeScopes } from "../../lib/decision-detail";
import type {
  MobileNotice,
  MobileNotifications,
  MobileOutboxRow,
  ParkedInvocation,
} from "../../lib/gateway";

// ── Copy that states a rule ────────────────────────────────────────────────

export const EMPTY_TITLE = "Nothing is waiting on you";
export const EMPTY_BODY =
  "Staged writes, lapsed connections and requests for wider access appear here. This page is empty most of the time, and that is the healthy state.";
export const EMPTY_ACTION = "Review standing grants";
export const DENY_TITLE = "Deny this write";
export const DENY_SUB =
  "Nothing is sent. The automation is told it was refused, and remembers.";
export const SENDING_FACT_KEY = "nothing has been sent";
export const SENDING_FACT_VALUE =
  "approving sends it immediately and cannot be undone";
export const CANNOT_EDIT_KEY = "cannot be edited";
export const CANNOT_EDIT_VALUE =
  "the gateway has no rebuilder for this verb, so approving sends exactly what is quoted above";
export const GRANTS_NOTE =
  "A standing grant skips this page for one narrow thing. Revoking one takes effect on the next run.";
export const NO_GRANTS_NOTE =
  "No standing grants yet — “always allow” on an approval mints one.";
/** The eyebrow states WHICH state this is; the title is the reference's own
 *  sentence about what failed. The role uppercases it — the string does not. */
export const ERROR_EYEBROW = "This page could not load";
/** The reference's error eyebrow, promoted to the panel's title. */
export const ERROR_TITLE = "Could not reach the consent store";
export const ERROR_BODY =
  "The gateway answered, but the queue that holds staged writes did not. Nothing has been approved or denied in the meantime, and nothing expired.";
export const ERROR_RETRY = "Try again";
export const LOADING_NOTE =
  "A row knows its shape before its content arrives, so nothing reflows when it does.";
export const HEALTH_DETAIL =
  "Nothing here has happened yet. Approving is the act.";
export const ALWAYS_TITLE = "Approve without asking again";
export const ALWAYS_SUB =
  "Future writes matching this actor, verb and target send without stopping here. Revoking the grant it mints lives further down this page.";
export const EDIT_TITLE = "Edit before sending";
export const EDIT_SUB =
  "Your changes replace the draft above. Nothing is sent until you approve.";
/** The one sentence that says where the reconnection ceremony finishes. */
export const RECONNECT_NOTE =
  "Opens a secure browser inside Centraid — stay here until it closes.";
/** This phone is not paired: an error, with the one way forward stated. */
export const NOT_PAIRED = "This phone is not paired with a gateway yet.";

/** The waiting-queue filter (spec §2 `full`), ids first, copy second. */
export const WAITING_CHIPS = [
  { key: "all", label: "Everything" },
  { key: "risk", label: "High risk" },
  { key: "auth", label: "Authorization" },
  { key: "staged", label: "Staged writes" },
] as const;

export type WaitingFilter = (typeof WAITING_CHIPS)[number]["key"];

/** Which chip a waiting item answers to. One item, one chip — an item that
 *  matched two would make "showing 3 of 12" a lie in one of them. */
export type WaitingKind = "staged" | "auth" | "risk";

export function matchesFilter(
  filter: WaitingFilter,
  kind: WaitingKind
): boolean {
  return filter === "all" || filter === kind;
}

// ── Phrasing ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function countWord(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

export function join(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function parsed(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : at;
}

/** How long ago, in the register a queue uses: minutes and hours while it is
 *  still today, a named day after that. Never a bare ISO string. */
export function agoPhrase(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${countWord(Math.round(ago / MINUTE), "minute")} ago`;
  if (ago < DAY) return `${countWord(Math.round(ago / HOUR), "hour")} ago`;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/** `staged 4 minutes ago`, or nothing at all when the stamp is unreadable —
 *  an invented time on a consent surface is worse than a missing one. */
export function stampPhrase(
  iso: string | null | undefined,
  now: number,
  verb: string
): string | undefined {
  const at = parsed(iso);
  return at === undefined ? undefined : `${verb} ${agoPhrase(at, now)}`;
}

/**
 * WHO staged or asked, as words rather than a coloured chip (mismatch 1).
 */
export function callerPhrase(kind: string, caller: string | null): string {
  const name = caller ?? kind;
  switch (kind) {
    case "app":
      return `the app ${name}`;
    case "agent":
      return `the automation ${name}`;
    case "assistant":
      return "the assistant";
    default:
      return name;
  }
}

/**
 * What KIND of outbound write this is, from the verb and connection the
 * gateway staged it under. Never guesses beyond those two: an unrecognised
 * verb is "Outbound write", which is true of every item here.
 */
export function outboundLabel(row: {
  verb: string;
  connection: { kind: string };
}): string {
  const signal = `${row.verb} ${row.connection.kind}`.toLowerCase();
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

/** Severity as a WORD, not a coloured rail. `info` gets nothing: a quiet
 *  update needs no label. */
export function noticeSeverityLabel(
  kind: string,
  severity: MobileNotice["severity"]
): string {
  if (severity === "info") return "";
  if (kind === "gateway-health")
    return severity === "high" ? "Down" : "Degraded";
  return severity === "high" ? "Failed" : "Warning";
}

function spanWords(ms: number): string {
  if (ms >= DAY) return countWord(Math.round(ms / DAY), "day");
  if (ms >= HOUR) return countWord(Math.round(ms / HOUR), "hour");
  return countWord(Math.max(1, Math.round(ms / MINUTE)), "minute");
}

/**
 * Collapsed-notice duration phrase. A day-plus run of failures reads as
 * "failing for 6 days" — the thing the owner actually needs; anything shorter,
 * or merely informational, keeps the neutral "×6 over 3 hours". `undefined`
 * for an uncollapsed notice, which has no span to tell.
 */
export function noticeSpanPhrase(
  row: Pick<MobileNotice, "count" | "firstAt" | "lastAt" | "severity">
): string | undefined {
  if (row.count <= 1) return undefined;
  const first = parsed(row.firstAt);
  const last = parsed(row.lastAt);
  if (first === undefined || last === undefined || last <= first)
    return `×${String(row.count)}`;
  if (row.severity !== "info" && last - first >= DAY)
    return `failing for ${spanWords(last - first)}`;
  return `×${String(row.count)} over ${spanWords(last - first)}`;
}

export function noticeSub(notice: MobileNotice, now: number): string {
  return join([
    notice.kind.replaceAll("-", " "),
    stampPhrase(notice.lastAt, now, "last"),
    noticeSpanPhrase(notice),
  ]);
}

// ── The queue ──────────────────────────────────────────────────────────────

/** A notice that DEMANDS something, rather than one that reports (mismatch 2). */
export function isAttention(notice: MobileNotice): boolean {
  return notice.archivedAt === null && notice.severity !== "info";
}

export function activeNotices(
  notices: readonly MobileNotice[]
): MobileNotice[] {
  return notices.filter((notice) => notice.archivedAt === null);
}

/** Everything that is waiting on the owner, across all five wire shapes. */
export function waitingTotal(data: MobileNotifications): number {
  const { decisions } = data;
  return (
    decisions.outbox.length +
    decisions.needsAuth.length +
    decisions.parked.length +
    decisions.scopeRequests.length +
    data.notices.filter(isAttention).length
  );
}

/**
 * Where `ready` becomes `full` — the queue length at which the filter chips
 * start earning their space. Four chips over four items is furniture; the
 * reference's own `ready` fixture is 3 rows and its `full` one is 7.
 */
export const FULL_AT = WAITING_CHIPS.length;

export function opsStateFor(
  load: "loading" | "ready" | "error",
  waiting: number
): OpsState {
  if (load !== "ready") return load;
  if (waiting === 0) return "empty";
  return waiting > FULL_AT ? "full" : "ready";
}

/** The section's count line: what is on screen, and what is not. */
export function waitingMeta(shown: number, total: number): string {
  return shown < total
    ? `showing ${String(shown)} of ${String(total)}`
    : `${String(total)} waiting`;
}

/** The standing line. No inline verb, ever: the page's whole content IS the
 *  thing to act on, so a verb in the status line would point at itself. */
export function approvalsHealth(waiting: number): HealthCopy {
  return {
    detail: HEALTH_DETAIL,
    emptyText: "Nothing to attend to · nothing needs you here right now.",
    errorText:
      "This page could not load · everything else on the gateway is unaffected.",
    label: `${countWord(waiting, "item")} waiting on you`,
    loadingText: "Reading from the gateway",
  };
}

// ── The staged write ───────────────────────────────────────────────────────

const TITLE_KEYS = ["subject", "title", "name"];
const BODY_KEYS = ["body", "text", "message"];
const ADDRESS_KEYS = ["to", "cc", "bcc", "from"];

function readString(
  artifact: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = artifact[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** One artifact value as a readable string — never `[object Object]`. */
export function factValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((item) => factValue(item)).join(", ");
  return JSON.stringify(value) ?? String(value);
}

export function stagedTitle(row: MobileOutboxRow): string {
  return readString(row.artifact, TITLE_KEYS) ?? row.target;
}

/** The words somebody else wrote, which is why the panel quotes them. */
export function stagedBody(row: MobileOutboxRow): string {
  return readString(row.artifact, BODY_KEYS) ?? row.target;
}

export function stagedEyebrow(row: MobileOutboxRow, now: number): string {
  return join([
    outboundLabel(row),
    `staged by ${callerPhrase(row.actorKind, row.actor)}`,
    stampPhrase(row.stagedAt, now, "staged"),
  ]);
}

/**
 * Every fact about where this write is going, in the order an envelope is
 * read, then everything else the artifact carries — nothing staged is hidden
 * from the person approving it. The irreversibility fact is last and `net`,
 * because it is the one that changes what approving MEANS.
 */
export function stagedFacts(row: MobileOutboxRow): PanelFact[] {
  const facts: PanelFact[] = [];
  const used = new Set([
    ...ADDRESS_KEYS,
    ...TITLE_KEYS.filter((key) => readString(row.artifact, [key])),
    ...BODY_KEYS.filter((key) => readString(row.artifact, [key])),
  ]);
  for (const key of ADDRESS_KEYS) {
    const value = row.artifact[key];
    if (value !== undefined && value !== null)
      facts.push({ key, value: factValue(value) });
  }
  for (const [key, value] of Object.entries(row.artifact)) {
    if (used.has(key)) continue;
    facts.push({
      key: key.replaceAll("_", " "),
      value: factValue(value),
    });
  }
  facts.push({
    key: "connection",
    value: `${row.connection.label} · ${row.connection.kind}`,
  });
  if (!row.canEdit)
    facts.push({
      key: CANNOT_EDIT_KEY,
      value: CANNOT_EDIT_VALUE,
    });
  facts.push({
    key: SENDING_FACT_KEY,
    net: true,
    value: SENDING_FACT_VALUE,
  });
  return facts;
}

// ── Waiting rows ───────────────────────────────────────────────────────────

/** One queue row, already worded. The screen binds the handler. */
export interface WaitingRowCopy {
  key: string;
  kind: WaitingKind;
  title: string;
  sub: string;
  /** The one state word beside the title. */
  meta: string;
  /** Metadata takes `net` — this is about something leaving the device, or a
   *  connection to the outside that has failed. */
  net: boolean;
  action: string;
}

/**
 * Bind a worded row to what its verb actually does.
 *
 * The copy model names the verb and the screen owns the handler, which is why
 * `action` here is a bare word rather than a control. `hint` is composed in one
 * place because it is the same sentence on every row — the verb plus the thing
 * it acts on — and that sentence is what tells ten identical "Open" controls
 * apart for a screen reader (#708 B.4).
 */
export function rowVerb(
  copy: { title: string; action?: string },
  onPress: () => void,
  label?: string
): RowsBlockAction {
  const word = label ?? copy.action ?? "";
  return { hint: `${word} — ${copy.title}`, label: word, onPress };
}

export function outboxRowCopy(
  row: MobileOutboxRow,
  now: number
): WaitingRowCopy {
  return {
    action: "Review",
    key: row.itemId,
    kind: "staged",
    meta: "Staged",
    net: false,
    sub: join([
      row.connection.label,
      `staged by ${callerPhrase(row.actorKind, row.actor)}`,
      stampPhrase(row.stagedAt, now, "staged"),
    ]),
    title: stagedTitle(row),
  };
}

export function needsAuthRowCopy(row: {
  connectionId: string;
  kind: string;
  label: string;
  note: string | null;
}): WaitingRowCopy {
  return {
    action: "Reconnect",
    key: row.connectionId,
    kind: "auth",
    meta: "Lapsed",
    net: true,
    sub: join([row.note ?? `${row.kind} needs reconnecting`, RECONNECT_NOTE]),
    title: row.label,
  };
}

export function parkedRowCopy(
  row: ParkedInvocation,
  now: number,
  open: boolean
): WaitingRowCopy {
  return {
    action: open ? "Hide" : "Review",
    key: row.invocationId,
    kind: "risk",
    meta: "High risk",
    net: true,
    sub: join([
      `asked by ${callerPhrase(row.callerKind, row.caller)}`,
      stampPhrase(row.parkedAt, now, "parked"),
    ]),
    title: row.command,
  };
}

export function scopeRowCopy(
  row: {
    requestId: string;
    appId: string;
    purpose: string;
    requestedAt: string;
    scopes: Parameters<typeof describeScopes>[0];
  },
  now: number,
  open: boolean
): WaitingRowCopy {
  return {
    action: open ? "Hide" : "Review",
    key: row.requestId,
    kind: "auth",
    meta: "New scope",
    net: false,
    sub: join([
      row.purpose,
      describeScopes(row.scopes),
      stampPhrase(row.requestedAt, now, "asked"),
    ]),
    title: `${row.appId} is asking for wider access`,
  };
}

export function noticeRowCopy(
  notice: MobileNotice,
  now: number
): WaitingRowCopy {
  return {
    action: "Open",
    key: notice.noticeId,
    kind: "risk",
    meta: noticeSeverityLabel(notice.kind, notice.severity),
    net: notice.severity === "high",
    sub: noticeSub(notice, now),
    title: notice.headline,
  };
}

/** One standing `(actor, verb, target)` rule, as the vault stores it. */
export interface OutboxGrant {
  grantId: string;
  actor: string | null;
  actorId: string;
  verb: string;
  target: string;
  createdAt: string;
  revokedAt: string | null;
}

export function grantRowCopy(
  grant: OutboxGrant,
  now: number
): { key: string; title: string; sub: string; meta: string } {
  return {
    key: grant.grantId,
    meta: stampPhrase(grant.createdAt, now, "granted") ?? "",
    sub: `${grant.verb} → ${grant.target}`,
    title: `${grant.actor ?? grant.actorId} may always ${grant.verb}`,
  };
}

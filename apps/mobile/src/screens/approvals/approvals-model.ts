// What the Notifications place SAYS (#765, spec §2). Pure — no React, gateway
// or renderer — so the copy contract is under test without mounting anything.
// Three standing rules: kind badges are WORDS, never coloured pills (the one
// chromatic ink means "this leaves the device"); notices fold into the queue by
// what they NEED, never behind a source-type filter; and a busy control loses
// its verb entirely, so a second tap cannot stage a second decision.

import {
  APPROVALS_CANNOT_EDIT_KEY as CANNOT_EDIT_KEY,
  APPROVALS_CANNOT_EDIT_VALUE as CANNOT_EDIT_VALUE,
  APPROVALS_HEALTH_DETAIL as HEALTH_DETAIL,
  APPROVALS_SENDING_FACT_KEY as SENDING_FACT_KEY,
  APPROVALS_SENDING_FACT_VALUE as SENDING_FACT_VALUE,
} from "@centraid/client/approvals-copy";
import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";

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

// ─── copy that states a rule ───────
//
// Any sentence desktop also renders comes from `@centraid/client/approvals-copy`
// (#805) — one promise written twice can be broken on one surface. Re-exported
// under this file's own names.

export {
  APPROVALS_ALWAYS_TITLE as ALWAYS_TITLE,
  APPROVALS_DENY_SUB as DENY_SUB,
  APPROVALS_DENY_TITLE as DENY_TITLE,
  APPROVALS_EDIT_SUB as EDIT_SUB,
  APPROVALS_EDIT_TITLE as EDIT_TITLE,
  APPROVALS_EMPTY_ACTION as EMPTY_ACTION,
  APPROVALS_EMPTY_BODY as EMPTY_BODY,
  APPROVALS_EMPTY_TITLE as EMPTY_TITLE,
  APPROVALS_ERROR_BODY as ERROR_BODY,
  APPROVALS_ERROR_TITLE as ERROR_TITLE,
  APPROVALS_GRANTS_NOTE as GRANTS_NOTE,
  APPROVALS_NO_GRANTS_NOTE as NO_GRANTS_NOTE,
  APPROVALS_SENDING_FACT_KEY as SENDING_FACT_KEY,
  APPROVALS_SENDING_FACT_VALUE as SENDING_FACT_VALUE,
} from "@centraid/client/approvals-copy";
export {
  ERROR_HEALTH as ERROR_EYEBROW,
  RETRY_ACTION as ERROR_RETRY,
  SKELETON_NOTE as LOADING_NOTE,
} from "@centraid/client/surface-copy";
export const ALWAYS_SUB =
  "Future writes matching this actor, verb and target send without stopping here.";
export const RECONNECT_NOTE =
  "Opens a secure browser inside Centraid — stay here until it closes.";
export const NOT_PAIRED = "This phone is not paired with a gateway yet.";

export const WAITING_CHIPS = [
  { key: "all", label: "Everything" },
  { key: "risk", label: "High risk" },
  { key: "auth", label: "Authorization" },
  { key: "staged", label: "Staged writes" },
] as const;

export type WaitingFilter = (typeof WAITING_CHIPS)[number]["key"];

/** One item, one chip: matching two makes "showing 3 of 12" a lie. */
export type WaitingKind = "staged" | "auth" | "risk";

export function matchesFilter(
  filter: WaitingFilter,
  kind: WaitingKind
): boolean {
  return filter === "all" || filter === kind;
}

// ─── phrasing ───────

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

/** Nothing when the stamp is unreadable: an invented time on a consent surface
 *  is worse than a missing one. */
export function stampPhrase(
  iso: string | null | undefined,
  now: number,
  verb: string
): string | undefined {
  const at = parsed(iso);
  return at === undefined ? undefined : `${verb} ${agoPhrase(at, now)}`;
}

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

/** Never guesses past verb and connection kind: an unrecognised verb is
 * "Outbound write", true of every item here. */
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

/** `undefined` for an uncollapsed notice, which has no span to tell. */
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

// ─── the queue ───────

export function isAttention(notice: MobileNotice): boolean {
  return notice.archivedAt === null && notice.severity !== "info";
}

export function activeNotices(
  notices: readonly MobileNotice[]
): MobileNotice[] {
  return notices.filter((notice) => notice.archivedAt === null);
}

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

/** Where `ready` becomes `full`: four chips over four items is furniture. */
export const FULL_AT = WAITING_CHIPS.length;

export function opsStateFor(
  load: "loading" | "ready" | "error",
  waiting: number
): OpsState {
  if (load !== "ready") return load;
  if (waiting === 0) return "empty";
  return waiting > FULL_AT ? "full" : "ready";
}

export function waitingMeta(shown: number, total: number): string {
  return shown < total
    ? `showing ${String(shown)} of ${String(total)}`
    : `${String(total)} waiting`;
}

/** No inline verb, ever: the page's content IS the thing to act on. */
export function approvalsHealth(waiting: number): HealthCopy {
  return {
    detail: HEALTH_DETAIL,
    emptyText: EMPTY_HEALTH,
    errorText: ERROR_HEALTH,
    label: `${countWord(waiting, "item")} waiting on you`,
    loadingText: READING_HEALTH,
  };
}

// ─── the staged write ───────

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

/** Never `[object Object]`. */
export function factValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((item) => factValue(item)).join(", ");
  return JSON.stringify(value) ?? String(value);
}

export function stagedTitle(row: MobileOutboxRow): string {
  return readString(row.artifact, TITLE_KEYS) ?? row.target;
}

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

/** Nothing staged is hidden from the approver. The irreversibility fact stays
 * last and `net`: it changes what approving MEANS. */
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

// ─── waiting rows ───────

export interface WaitingRowCopy {
  key: string;
  kind: WaitingKind;
  title: string;
  sub: string;
  meta: string;
  /** `net` only for bytes leaving the device or an outside link that failed. */
  net: boolean;
  action: string;
}

/** `action` stays a bare word: the screen owns the handler. `hint` keeps ten
 * identical "Open" controls distinct to a screen reader (#708 B.4). */
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

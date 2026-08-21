// What the Connectors place SAYS about a connection (#765, spec §4).
//
// Pure: no React, no gateway, no renderer. The screen owns the frame and the
// hook owns the wire; every word a row or the standing line carries is decided
// here, so the copy contract is under test without mounting anything — the
// same split `kit/components/health-line.ts` and `screens/home/home-status.ts`
// already make.
//
// Two honest departures from the reference's demo rows, both forced by what
// the gateway actually serves a phone:
//
//  1. The reference's healthy row carries a `Configure` verb. Mobile has no
//     credential wizard (configuring a BYO client means typing a client id and
//     secret, which is a desktop act), so a healthy row's verb is `Pause` —
//     the one thing `PATCH /_vault/connections/<id>` genuinely does from here.
//     A `Configure` button that opened nothing would be worse than no button.
//  2. `Expiring` is computed from `tokenExpiresAt` rather than reported: the
//     gateway sends the timestamp and no verdict, so the threshold below is
//     this screen's, and it is stated rather than hidden.

import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { ConnectionEntry } from "../../lib/connections";

/** The one thing this screen can do to a row, chosen by its health. */
export type ConnectorAct = "reauthorize" | "pause" | "resume";

/** One connection, already worded. The screen binds the handler. */
export interface ConnectorRow {
  key: string;
  connectionId: string;
  title: string;
  sub: string;
  /** The one state word beside the title. */
  meta: string;
  /** Metadata takes `net` — this connection to the outside has failed. */
  net: boolean;
  action: string;
  act: ConnectorAct;
}

/** The chip row's four narrowings (spec §4 `full`). */
export type ConnectorFilter = "all" | "failing" | "needs-auth" | "paused";

/**
 * Where `ready` becomes `full` — the row count at which the page stops being
 * readable in one scroll and the filter chips start earning their space. The
 * reference's own two fixtures are 5 rows (`ready`) and 9 (`full`); 8 is the
 * boundary between them.
 */
export const FULL_AT = 8;

/** Inside this window a live token is worth mentioning before it lapses. */
const EXPIRING_WITHIN_DAYS = 14;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "1 minute" / "4 minutes" — the plural rule this module needs, once. */
export function countWord(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function join(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function parsed(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : at;
}

/** `9 August` — a day the member would name, not an ISO string. */
function dayPhrase(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/**
 * How long ago something last worked, in the register the row uses: minutes
 * and hours while it is still today, a named day after that.
 */
export function agoPhrase(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${countWord(Math.round(ago / MINUTE), "minute")} ago`;
  if (ago < DAY) return `${countWord(Math.round(ago / HOUR), "hour")} ago`;
  return dayPhrase(at);
}

/** `last worked 4 minutes ago`, or the honest absence of any run. */
export function lastWorkedPhrase(entry: ConnectionEntry, now: number): string {
  const at = parsed(entry.lastRunAt);
  return at === undefined ? "never run" : `last worked ${agoPhrase(at, now)}`;
}

/**
 * The token's remaining life, when it is short enough to matter. `undefined`
 * for a credential with no expiry, an unreadable one, or one with more than
 * `EXPIRING_WITHIN_DAYS` left — a phrase that always appears is not news.
 */
export function expiryPhrase(
  entry: ConnectionEntry,
  now: number
): string | undefined {
  const at = parsed(entry.tokenExpiresAt);
  if (at === undefined) return undefined;
  const left = at - now;
  if (left <= 0) return "the token has expired";
  if (left > EXPIRING_WITHIN_DAYS * DAY) return undefined;
  return `token expires in ${countWord(Math.max(1, Math.round(left / DAY)), "day")}`;
}

function credentialWord(entry: ConnectionEntry): string {
  if (entry.credKind === "oauth2") return "OAuth";
  if (entry.credKind === "api_key") return "API key";
  return "no credential";
}

/** The state word in the row's one mono slot. */
export function statusWord(entry: ConnectionEntry, now: number): string {
  switch (entry.status) {
    case "needs-auth":
      return "Needs re-auth";
    case "failing":
      return "Failing";
    case "paused":
      return "Paused";
    case "active":
      return expiryPhrase(entry, now) === undefined ? "Fine" : "Expiring";
  }
}

/** `alex@pemberton.example · OAuth · last worked 9 August`. */
export function subLine(entry: ConnectionEntry, now: number): string {
  // A lapsed connection says WHY in the broker's own words when it has them;
  // "last worked 9 August" is true but answers a question nobody asked once
  // the row already says `Needs re-auth`.
  const tail =
    entry.status === "needs-auth" && entry.authNote
      ? entry.authNote
      : lastWorkedPhrase(entry, now);
  return join([
    entry.principal ?? "no account",
    credentialWord(entry),
    tail,
    entry.status === "active" ? expiryPhrase(entry, now) : undefined,
  ]);
}

function actFor(entry: ConnectionEntry): ConnectorAct {
  if (entry.status === "needs-auth") return "reauthorize";
  return entry.status === "paused" ? "resume" : "pause";
}

const ACTION_LABEL: Record<ConnectorAct, string> = {
  pause: "Pause",
  reauthorize: "Re-authorize",
  resume: "Resume",
};

/** Whether this connection's trouble is with the outside world. */
export function isNet(entry: ConnectionEntry): boolean {
  return entry.status === "needs-auth" || entry.status === "failing";
}

/** One connection, worded. */
export function connectorRow(
  entry: ConnectionEntry,
  now: number
): ConnectorRow {
  const act = actFor(entry);
  return {
    act,
    action: ACTION_LABEL[act],
    connectionId: entry.connectionId,
    key: entry.connectionId,
    meta: statusWord(entry, now),
    net: isNet(entry),
    sub: subLine(entry, now),
    title: entry.label,
  };
}

/** Does this connection survive the chip that is on? */
export function matchesFilter(
  entry: ConnectionEntry,
  filter: ConnectorFilter
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "failing":
      return entry.status === "failing";
    case "needs-auth":
      return entry.status === "needs-auth";
    case "paused":
      return entry.status === "paused";
  }
}

/** The chip row, in the reference's order, with the live one marked. */
export function filterChips(
  filter: ConnectorFilter
): { key: ConnectorFilter; label: string; on: boolean }[] {
  const chips: [ConnectorFilter, string][] = [
    ["all", "All"],
    ["failing", "Failing"],
    ["needs-auth", "Needs re-auth"],
    ["paused", "Paused"],
  ];
  return chips.map(([key, label]) => ({ key, label, on: key === filter }));
}

/**
 * `12 connections · 1 needs re-authorization · 1 paused` — the reference's own
 * meta sentence. The app bar suppresses it at phone width, so it lands on the
 * section heading instead, where the count belongs to the list under it.
 */
export function countSentence(entries: readonly ConnectionEntry[]): string {
  const needsAuth = entries.filter((e) => e.status === "needs-auth").length;
  const paused = entries.filter((e) => e.status === "paused").length;
  const failing = entries.filter((e) => e.status === "failing").length;
  return join([
    countWord(entries.length, "connection"),
    needsAuth > 0
      ? `${String(needsAuth)} need${needsAuth === 1 ? "s" : ""} re-authorization`
      : undefined,
    failing > 0 ? `${String(failing)} failing` : undefined,
    paused > 0 ? `${String(paused)} paused` : undefined,
  ]);
}

/** `showing 3 of 12` — only ever shown while a chip narrows the list. */
export function showingSentence(shown: number, total: number): string {
  return `showing ${String(shown)} of ${String(total)}`;
}

/**
 * Which of the five states the page is in. `full`/`empty` are read off the
 * row count rather than stored, so they cannot disagree with what rendered.
 */
export function opsStateFor(
  load: "loading" | "error" | "ready",
  count: number
): OpsState {
  if (load === "loading") return "loading";
  if (load === "error") return "error";
  if (count === 0) return "empty";
  return count >= FULL_AT ? "full" : "ready";
}

/** The first connection this screen could actually re-authorize, if any. */
export function firstNeedingAuth(
  entries: readonly ConnectionEntry[]
): ConnectionEntry | undefined {
  return entries.find((entry) => entry.status === "needs-auth");
}

/**
 * The standing line's words. The generic three are the reference's own
 * per-state sentences; `healthLineFor` decides which is published and whether
 * the inline verb comes with it.
 */
export function connectorsHealth(
  entries: readonly ConnectionEntry[],
  now: number
): HealthCopy {
  const needsAuth = entries.filter((e) => e.status === "needs-auth");
  const failing = entries.filter((e) => e.status === "failing");
  const paused = entries.filter((e) => e.status === "paused").length;
  const generic = {
    emptyText: EMPTY_HEALTH,
    errorText: ERROR_HEALTH,
    loadingText: READING_HEALTH,
  };
  const first = needsAuth[0];
  if (first) {
    return {
      ...generic,
      action: "Re-authorize",
      detail:
        first.authNote ??
        `Its credential no longer works, and nothing it feeds has run since ${lastWorkedPhrase(first, now).replace("last worked ", "")}.`,
      label:
        needsAuth.length > 1
          ? `${countWord(needsAuth.length, "connection")} need re-authorization`
          : `${first.label} needs re-authorization`,
    };
  }
  const failingFirst = failing[0];
  if (failingFirst) {
    return {
      ...generic,
      detail:
        failingFirst.authNote ??
        `It last worked ${lastWorkedPhrase(failingFirst, now).replace("last worked ", "")}.`,
      label:
        failing.length > 1
          ? `${countWord(failing.length, "connection")} are failing`
          : `${failingFirst.label} is failing`,
    };
  }
  const working = entries.length - paused;
  return {
    ...generic,
    detail:
      paused > 0
        ? `${countWord(paused, "connection")} you paused stay paused until you resume them.`
        : "Nothing needs re-authorization.",
    label:
      working === 1
        ? "1 connection is working"
        : `${countWord(working, "connection")} are working`,
  };
}

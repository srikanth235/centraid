import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { ConnectionEntry } from "../../lib/connections";

export type ConnectorAct = "reauthorize" | "pause" | "resume";

export interface ConnectorRow {
  key: string;
  connectionId: string;
  title: string;
  sub: string;
  meta: string;
  net: boolean;
  action: string;
  act: ConnectorAct;
}

export type ConnectorFilter = "all" | "failing" | "needs-auth" | "paused";

export const FULL_AT = 8;

const EXPIRING_WITHIN_DAYS = 14;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

function dayPhrase(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

export function agoPhrase(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${countWord(Math.round(ago / MINUTE), "minute")} ago`;
  if (ago < DAY) return `${countWord(Math.round(ago / HOUR), "hour")} ago`;
  return dayPhrase(at);
}

export function lastWorkedPhrase(entry: ConnectionEntry, now: number): string {
  const at = parsed(entry.lastRunAt);
  return at === undefined ? "never run" : `last worked ${agoPhrase(at, now)}`;
}

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

export function subLine(entry: ConnectionEntry, now: number): string {
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

export function isNet(entry: ConnectionEntry): boolean {
  return entry.status === "needs-auth" || entry.status === "failing";
}

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

export function showingSentence(shown: number, total: number): string {
  return `showing ${String(shown)} of ${String(total)}`;
}

export function opsStateFor(
  load: "loading" | "error" | "ready",
  count: number
): OpsState {
  if (load === "loading") return "loading";
  if (load === "error") return "error";
  if (count === 0) return "empty";
  return count >= FULL_AT ? "full" : "ready";
}

export function firstNeedingAuth(
  entries: readonly ConnectionEntry[]
): ConnectionEntry | undefined {
  return entries.find((entry) => entry.status === "needs-auth");
}

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

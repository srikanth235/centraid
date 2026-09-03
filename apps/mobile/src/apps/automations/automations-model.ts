import { automationsErrorBody } from "@centraid/client/automations-copy";
import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { AutomationRow, AutomationTemplate } from "../../lib/automations";

export const FULL_AT = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export interface RunEntry {
  key: string;
  ref: string;
  name: string;
  ok: boolean;
  startedAt: number;
  detail: string;
}

export type AutomationStatus = "failing" | "paused" | "draft" | "active";

export type AutomationAct = "open" | "resume";

export type AutomationFilter = "all" | "failing" | "paused" | "drafts";

export interface FailureStreak {
  count: number;
  startedAt: number;
}

export interface AutomationRowCopy {
  key: string;
  ref: string;
  title: string;
  sub: string;
  meta: string;
  net: boolean;
  action: string;
  act: AutomationAct;
  status: AutomationStatus;
  streak: FailureStreak | null;
}

export interface RunRowCopy {
  key: string;
  ref: string;
  title: string;
  sub: string;
  meta: string;
  net: boolean;
}

export interface RunContext {
  runs: readonly RunEntry[];
  known: ReadonlySet<string>;
  now: number;
}

export function countWord(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function join(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function automationDayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

export function whenLabel(at: number, now: number): string {
  const ago = now - at;
  if (ago < 0) return clockLabel(at);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return clockLabel(at);
  if (ago < 2 * DAY) return "yesterday";
  if (ago < WEEK)
    return new Date(at).toLocaleDateString(undefined, { weekday: "long" });
  return automationDayLabel(at);
}

function capitalized(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function failureStreak(
  ref: string,
  runs: readonly RunEntry[]
): FailureStreak | null {
  let count = 0;
  let startedAt = 0;
  for (const run of runs) {
    if (run.ref !== ref) continue;
    if (run.ok) break;
    count += 1;
    startedAt = run.startedAt;
  }
  return count === 0 ? null : { count, startedAt };
}

function newestRunOf(
  ref: string,
  runs: readonly RunEntry[]
): RunEntry | undefined {
  return runs.find((run) => run.ref === ref);
}

export function statusOf(
  row: AutomationRow,
  context: RunContext
): AutomationStatus {
  if (!row.enabled) return "paused";
  if (failureStreak(row.ref, context.runs)) return "failing";
  if (context.known.has(row.ref) && !newestRunOf(row.ref, context.runs))
    return "draft";
  return "active";
}

const STATUS_WORD: Record<AutomationStatus, string> = {
  active: "Active",
  draft: "Draft",
  failing: "Failing",
  paused: "Paused",
};

export function automationSub(row: AutomationRow, context: RunContext): string {
  const streak = failureStreak(row.ref, context.runs);
  const newest = newestRunOf(row.ref, context.runs);
  const tail = streak
    ? `failed ${countWord(streak.count, "run")} in a row, since ${automationDayLabel(streak.startedAt)}`
    : newest
      ? `last run ${whenLabel(newest.startedAt, context.now)}`
      : context.known.has(row.ref)
        ? "never run"
        : undefined;
  return join([row.scheduleLabel, tail]);
}

export function automationRowCopy(
  row: AutomationRow,
  context: RunContext
): AutomationRowCopy {
  const status = statusOf(row, context);
  const paused = status === "paused";
  return {
    act: paused ? "resume" : "open",
    action: paused ? "Resume" : "Open",
    key: row.ref,
    meta: STATUS_WORD[status],
    net: status === "failing",
    ref: row.ref,
    status,
    streak: failureStreak(row.ref, context.runs),
    sub: automationSub(row, context),
    title: row.name,
  };
}

export function runRowCopy(run: RunEntry, now: number): RunRowCopy {
  const when = whenLabel(run.startedAt, now);
  return {
    key: run.key,
    meta: run.ok ? capitalized(when) : "Failed",
    net: !run.ok,
    ref: run.ref,
    sub: join([run.ok ? "Succeeded" : "Failed", run.detail, when]),
    title: run.name,
  };
}

export function suggestionRowCopy(
  template: AutomationTemplate,
  installing: string | undefined
): { key: string; title: string; sub: string; action: string } {
  return {
    action: installing === template.id ? "Adding…" : "Create",
    key: template.id,
    sub: join([template.desc, template.triggerLabel]),
    title: template.name,
  };
}

export function automationMatchesFilter(
  status: AutomationStatus,
  filter: AutomationFilter
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "failing":
      return status === "failing";
    case "paused":
      return status === "paused";
    case "drafts":
      return status === "draft";
  }
}

export function filterChips(
  filter: AutomationFilter
): { key: AutomationFilter; label: string; on: boolean }[] {
  const chips: [AutomationFilter, string][] = [
    ["all", "All"],
    ["failing", "Failing"],
    ["paused", "Paused"],
    ["drafts", "Drafts"],
  ];
  return chips.map(([key, label]) => ({ key, label, on: key === filter }));
}

export function countSentence(copies: readonly AutomationRowCopy[]): string {
  const failing = copies.filter((copy) => copy.status === "failing").length;
  const paused = copies.filter((copy) => copy.status === "paused").length;
  return join([
    countWord(copies.length, "automation"),
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

export function worstFailure(
  copies: readonly AutomationRowCopy[]
): AutomationRowCopy | undefined {
  return [...copies]
    .filter((copy) => copy.status === "failing")
    .sort((a, b) => (b.streak?.count ?? 1) - (a.streak?.count ?? 1))[0];
}

export {
  AUTOMATIONS_EMPTY_ACTION as EMPTY_ACTION,
  AUTOMATIONS_EMPTY_BODY as EMPTY_BODY,
  AUTOMATIONS_EMPTY_TITLE as EMPTY_TITLE,
  AUTOMATIONS_ERROR_RETRY as ERROR_RETRY,
  AUTOMATIONS_ERROR_TITLE as ERROR_TITLE,
} from "@centraid/client/automations-copy";

export function errorBody(sinceClock: string | undefined): string {
  return automationsErrorBody(sinceClock);
}

export function automationsHealth(
  copies: readonly AutomationRowCopy[],
  runs: readonly RunEntry[],
  now: number
): HealthCopy {
  const generic = {
    emptyText: EMPTY_HEALTH,
    errorText: ERROR_HEALTH,
    loadingText: READING_HEALTH,
  };
  const failing = copies.filter((copy) => copy.status === "failing");
  const worst = worstFailure(copies);
  if (worst) {
    const streak = worst.streak;
    return {
      ...generic,
      action: "Open the failure",
      detail: streak
        ? `${worst.title} has failed its last ${countWord(streak.count, "run")}, since ${automationDayLabel(streak.startedAt)}.`
        : `${worst.title} failed its last run.`,
      label:
        failing.length === 1
          ? "1 automation is failing"
          : `${countWord(failing.length, "automation")} are failing`,
    };
  }
  const newest = runs[0];
  return {
    ...generic,
    detail: newest
      ? `${countWord(copies.length, "automation")} on this gateway · last run ${whenLabel(newest.startedAt, now)}.`
      : `${countWord(copies.length, "automation")} on this gateway · nothing has run yet.`,
    label: "Nothing is failing",
  };
}

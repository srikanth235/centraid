// What the Automations place SAYS about an automation and its runs (#765,
// spec §3).
//
// Pure: no React, no gateway, no renderer. The hook owns the wire, the screen
// owns pressing, and every word a row, a section heading or the standing line
// carries is decided here — the same split `screens/connectors/connectors-model.ts`
// and `kit/components/health-line.ts` already make, so the copy contract is
// under test without mounting anything.
//
// THREE HONEST DEPARTURES from the reference's demo rows, all forced by what
// this gateway serves a phone:
//
//  1. The reference's status words come from a per-automation `statusKind` the
//     wire does not carry. `GET /_automations` sends `enabled` and nothing
//     else about health, so `Failing` and `Draft` are DERIVED from the run
//     feed — a leading streak of failed turns, and the absence of any turn at
//     all. A row whose runs were never read (see `known` below) is never
//     called a draft, because "never run" would then mean "never asked".
//  2. `Draft` here means "has never run", not "unpublished". This surface has
//     no authoring plane, so an automation that exists but has produced no
//     turn is the only draft-shaped thing it can honestly name.
//  3. The reference's suggestions note claims they come from what you already
//     do by hand. Nothing on this product watches you: the list is a slice of
//     the TEMPLATE CATALOGUE (`listAutomationTemplates`). The note says so —
//     the same correction `packages/client`'s screen made, word for word, so
//     both surfaces make the same promise.

import { automationsErrorBody } from "@centraid/client/automations-copy";
import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";

import type { HealthCopy, OpsState } from "../../kit/components/health-line";
import type { AutomationRow, AutomationTemplate } from "../../lib/automations";

/**
 * Where `ready` becomes `full` — the row count at which the page stops being
 * readable in one scroll and the filter chips start earning their space. The
 * reference's own two fixtures are 6 rows (`ready`) and 10 (`full`); 8 is the
 * boundary between them.
 */
export const FULL_AT = 8;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Past this, a run is named by its date rather than by its weekday. */
const WEEK = 7 * DAY;

/** One turn of one automation, already joined to the automation's name. */
export interface RunEntry {
  /** The turn id — the run's identity in the list. */
  key: string;
  /** `<ownerApp>/<id>`: which automation ran. */
  ref: string;
  name: string;
  ok: boolean;
  startedAt: number;
  /** The run's own sentence: its summary, or why it failed. May be empty. */
  detail: string;
}

/** What the one mono slot beside a title says. */
export type AutomationStatus = "failing" | "paused" | "draft" | "active";

/** The one thing this screen's row verb does. `open` reaches the automation's
 *  thread (its run log, and the `Run now` it already carries); `resume` is the
 *  enable write. */
export type AutomationAct = "open" | "resume";

/** The chip row's four narrowings (spec §3 `full`). */
export type AutomationFilter = "all" | "failing" | "paused" | "drafts";

/** An unbroken run of failures at the head of one automation's history. */
export interface FailureStreak {
  /** How many runs in a row failed, newest first, before the first success. */
  count: number;
  /** When the streak started — the OLDEST failure in it. */
  startedAt: number;
}

/** One automation, worded. The screen binds the handlers. */
export interface AutomationRowCopy {
  key: string;
  ref: string;
  title: string;
  sub: string;
  meta: string;
  /** Metadata takes `net` — this automation's last runs failed. */
  net: boolean;
  action: string;
  act: AutomationAct;
  status: AutomationStatus;
  /** Kept on the copy so the standing line can pick the WORST failure without
   *  recounting the feed from a second reading of it. */
  streak: FailureStreak | null;
}

/** One run, worded. */
export interface RunRowCopy {
  key: string;
  ref: string;
  title: string;
  sub: string;
  meta: string;
  net: boolean;
}

/** The run feed, plus which automations it is actually an answer for. */
export interface RunContext {
  /** Newest first, across every automation the fan-out reached. */
  runs: readonly RunEntry[];
  /** The refs whose runs were READ. A ref outside this set has no run history
   *  on this page — which is different from having none. */
  known: ReadonlySet<string>;
  /** The clock every relative phrase is measured from (the read's own). */
  now: number;
}

/** "1 run" / "3 runs" — the plural rule this module needs, once. */
export function countWord(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function join(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/** "09:12" — the clock the error panel's "nothing has run since" clause takes. */
export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "4 August" — the day a failure streak began. Day and month only: a year on
 *  a run that failed this week reads as an archive entry. */
export function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
  });
}

/**
 * When a run happened, in the register the row uses: a clock while it is still
 * today, `yesterday`, a weekday inside the week, a date after that.
 */
export function whenLabel(at: number, now: number): string {
  const ago = now - at;
  if (ago < 0) return clockLabel(at);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return clockLabel(at);
  if (ago < 2 * DAY) return "yesterday";
  if (ago < WEEK)
    return new Date(at).toLocaleDateString(undefined, { weekday: "long" });
  return dayLabel(at);
}

/** The meta slot shouts its first letter; the sub line does not. */
function capitalized(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * The unbroken run of failures at the head of one automation's history.
 *
 * Counted from the newest run backwards and stopped at the first success,
 * which is what makes "has failed its last 3 runs" a true sentence rather than
 * a total. `null` when the newest run succeeded, or when the feed carries no
 * run for this automation at all.
 */
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

/** The newest run of one automation, if the feed carries one. */
function newestRunOf(
  ref: string,
  runs: readonly RunEntry[]
): RunEntry | undefined {
  return runs.find((run) => run.ref === ref);
}

/** Which of the four state words this automation takes. */
export function statusOf(
  row: AutomationRow,
  context: RunContext
): AutomationStatus {
  // The member's own act leads: an automation they paused says `Paused`, even
  // if the last run before they paused it failed.
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

/** `Every Monday at 08:00 · failed 3 runs in a row, since 4 August`. */
export function automationSub(row: AutomationRow, context: RunContext): string {
  const streak = failureStreak(row.ref, context.runs);
  const newest = newestRunOf(row.ref, context.runs);
  const tail = streak
    ? `failed ${countWord(streak.count, "run")} in a row, since ${dayLabel(streak.startedAt)}`
    : newest
      ? `last run ${whenLabel(newest.startedAt, context.now)}`
      : context.known.has(row.ref)
        ? "never run"
        : undefined;
  return join([row.scheduleLabel, tail]);
}

/**
 * One automation, worded.
 *
 * The manifest description that used to sit under the name is deliberately not
 * here: the row's second line is what fires it and how it last went (spec §3),
 * and the description is the automation's own prose, which belongs where the
 * automation is opened rather than repeated eleven times down a list.
 */
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

/** One run, worded (spec §3, block 4). */
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

/** One template, worded as the suggestion it is. */
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

/** Does this automation survive the chip that is on? */
export function matchesFilter(
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

/** The chip row, in the reference's order, with the live one marked. */
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

/**
 * `12 automations · 1 failing · 2 paused` — the reference's own meta sentence.
 * The app bar suppresses it at phone width (spec §11), so it lands on the
 * section heading instead, where the count belongs to the list under it.
 */
export function countSentence(copies: readonly AutomationRowCopy[]): string {
  const failing = copies.filter((copy) => copy.status === "failing").length;
  const paused = copies.filter((copy) => copy.status === "paused").length;
  return join([
    countWord(copies.length, "automation"),
    failing > 0 ? `${String(failing)} failing` : undefined,
    paused > 0 ? `${String(paused)} paused` : undefined,
  ]);
}

/** `showing 3 of 12` — only ever shown while a chip narrows the list. */
export function showingSentence(shown: number, total: number): string {
  return `showing ${String(shown)} of ${String(total)}`;
}

/**
 * Which of the five states the page is in. `full`/`empty` are read off the row
 * count rather than stored, so they cannot disagree with what rendered.
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

/**
 * The failure the standing line names: the LONGEST streak, because "has failed
 * its last 6 runs" is a different problem from "failed once".
 */
export function worstFailure(
  copies: readonly AutomationRowCopy[]
): AutomationRowCopy | undefined {
  return [...copies]
    .filter((copy) => copy.status === "failing")
    .sort((a, b) => (b.streak?.count ?? 1) - (a.streak?.count ?? 1))[0];
}

// The empty and error states are the same words the desktop overview says, so
// they come from `@centraid/client/automations-copy` (issue #805), re-exported
// under this file's own names.
export {
  AUTOMATIONS_EMPTY_ACTION as EMPTY_ACTION,
  AUTOMATIONS_EMPTY_BODY as EMPTY_BODY,
  AUTOMATIONS_EMPTY_TITLE as EMPTY_TITLE,
  AUTOMATIONS_ERROR_RETRY as ERROR_RETRY,
  AUTOMATIONS_ERROR_TITLE as ERROR_TITLE,
} from "@centraid/client/automations-copy";

/** The error body. The "nothing has run since 09:12" clause is DROPPED when
 *  this screen has never had a successful read to take the time from — an
 *  invented clock is worse than a shorter sentence. */
export function errorBody(sinceClock: string | undefined): string {
  return automationsErrorBody(sinceClock);
}

/**
 * The standing line's words. The generic three are the reference's own
 * per-state sentences (spec §11); `healthLineFor` decides which is published
 * and whether the inline verb comes with it.
 */
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
      // The one inline verb, and it goes where the trouble is.
      action: "Open the failure",
      detail: streak
        ? `${worst.title} has failed its last ${countWord(streak.count, "run")}, since ${dayLabel(streak.startedAt)}.`
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

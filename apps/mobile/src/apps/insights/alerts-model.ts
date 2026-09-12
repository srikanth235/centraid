// What Activity's alerts tab SAYS (#1015 R-NY-2). Pure — no React, gateway or
// renderer — so the copy contract is under test without mounting anything.
//
// Every notice left Needs you for this tab, because a notice is news and not a
// decision. The gateway already collapses repeats onto one card per
// `(kind, sourceRef)`, so one active notice IS one standing line per source:
// a rule that keeps failing is one line that counts, and a recovery rewrites
// that same line rather than adding a second.
//
// Three rules, each the fix for a line the audit read on the simulator:
//  - no engine vocabulary: never the raw `kind` ("automation", "gateway
//    health"), never "last yesterday", never "×6 over 2 hours"
//  - the state word is said ONCE, in the meta, and the sub never repeats it
//  - a failed rule offers "Try again" only when there is a rule to re-run

import { formatRelative } from "../../kit/format";
import type { MobileNotice } from "../../lib/gateway";

export interface AlertLine {
  key: string;
  /** The server's headline — a sentence since R-NY-5, never an exception. */
  title: string;
  /** When, in the member's words; for a repeating problem, how often. */
  sub: string;
  /** The row's one state word, or empty for news that needs nothing. */
  meta: string;
  /** Only a failure's metadata takes `net`; the title stays primary ink. */
  net: boolean;
  /** The rule to re-run, when "Try again" means something. */
  retryRef: string | undefined;
}

/** The one state word a line carries. */
export function alertStateWord(
  notice: Pick<MobileNotice, "kind" | "severity">
): string {
  if (notice.severity === "info") return "";
  if (notice.kind === "gateway-health")
    return notice.severity === "high" ? "Down" : "Degraded";
  return notice.severity === "high" ? "Failed" : "Warning";
}

/** When it last happened; for a repeating problem, how many times too. A
 *  count on news that needs nothing would be a count of past failures on a
 *  line that now says the rule works. */
export function alertWhen(
  notice: Pick<MobileNotice, "count" | "lastAt" | "severity">,
  now: number
): string {
  const when = formatRelative(notice.lastAt, now);
  if (notice.severity === "info" || notice.count <= 1) return when;
  const times = `${String(notice.count)} times`;
  return when ? `${times} · ${when}` : times;
}

/** A failed rule's ref, or nothing. The ref is the notice's own
 *  `automationRef` detail, falling back to its source — the same reading
 *  `mobileNotificationsDestination` makes, so the retry and the row's tap
 *  always name the same rule. */
export function alertRetryRef(notice: MobileNotice): string | undefined {
  if (notice.detail.sourceType !== "automation") return undefined;
  if (notice.detail.outcome !== "failure") return undefined;
  return typeof notice.detail.automationRef === "string"
    ? notice.detail.automationRef
    : notice.sourceRef;
}

/** How many standing lines need a look: every active notice that is not
 *  news. The count the overview's way in states (#1015 R-NY-2). */
export function needsALookCount(
  notices: readonly Pick<MobileNotice, "archivedAt" | "severity">[]
): number {
  return notices.filter(
    (notice) => notice.archivedAt === null && notice.severity !== "info"
  ).length;
}

/**
 * Activity overview's standing way into the alerts view. It is ALWAYS drawn,
 * zero included: a view reachable only when something is wrong is a view the
 * member never learns exists, and Needs you no longer leads here. `undefined`
 * is "not read yet", which says nothing rather than an invented zero.
 */
export function alertsEntryCopy(count: number | undefined): {
  title: string;
  sub: string;
  net: boolean;
} {
  const sub =
    count === undefined
      ? ""
      : count === 0
        ? "Nothing needs a look"
        : `${String(count)} ${count === 1 ? "needs" : "need"} a look`;
  return { net: (count ?? 0) > 0, sub, title: "Alerts" };
}

/** The standing lines: every notice not filed away, one per source. */
export function alertLines(
  notices: readonly MobileNotice[],
  now: number
): { notice: MobileNotice; line: AlertLine }[] {
  return notices
    .filter((notice) => notice.archivedAt === null)
    .map((notice) => ({
      line: {
        key: notice.noticeId,
        meta: alertStateWord(notice),
        net: notice.severity === "high",
        retryRef: alertRetryRef(notice),
        sub: alertWhen(notice, now),
        title: notice.headline,
      },
      notice,
    }));
}

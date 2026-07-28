// Pure row-sorting and activity-feed grouping for AutomationsOverviewScreen —
// extracted so the screen stays under the repo's component-file cap and these
// stay trivially unit-testable.

import type {
  AuOverviewRowDTO,
  AuOverviewRunDTO,
} from "../screen-contracts.js";

/** Attention / failed-last-run first, then alphabetical — so the list answers
 *  "what needs me?" before "what's everything named?" */
export function sortOverviewRows(
  rows: readonly AuOverviewRowDTO[]
): AuOverviewRowDTO[] {
  return [...rows].sort((a, b) => {
    const aAtt = a.attentionCount > 0 || a.lastRunOk === false ? 1 : 0;
    const bAtt = b.attentionCount > 0 || b.lastRunOk === false ? 1 : 0;
    if (aAtt !== bAtt) return bAtt - aAtt;
    if (a.attentionCount !== b.attentionCount)
      return b.attentionCount - a.attentionCount;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** First segment of the meta label built by automationsData.ts's
 *  `buildOverviewData` — the activity row only wants the leading origin label
 *  ("Cron" / "Webhook" / "Manual" / …), not the duration/token detail the
 *  fleet row's run history already carries. */
export function runOrigin(metaLabel: string): string {
  return metaLabel.split(" · ")[0] ?? metaLabel;
}

/** Small-caps mono date-separator label for the activity feed — "Today" /
 *  "Yesterday" / "Mon, Jul 6" (mirrors the thread spine's date grouping,
 *  automationThreadData.ts's private `dateGroupLabel`, kept as an
 *  independent copy here since that helper isn't exported). */
export function dateGroupLabel(startedAt: number): string {
  const d = new Date(startedAt);
  const now = new Date();
  const ds = d.toDateString();
  if (ds === now.toDateString()) return "Today";
  if (ds === new Date(now.getTime() - 86_400_000).toDateString())
    return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export interface RunGroup {
  label: string;
  runs: AuOverviewRunDTO[];
}

/** Group already-newest-first runs into consecutive same-day buckets. */
export function groupRuns(runs: readonly AuOverviewRunDTO[]): RunGroup[] {
  const groups: RunGroup[] = [];
  for (const run of runs) {
    const label = dateGroupLabel(run.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }
  return groups;
}

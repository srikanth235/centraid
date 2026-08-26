import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  getGatewayHealth,
  getInsightsSummary,
  getUserPrefs,
  listAutomations,
  saveUserPrefs,
} from "../../../gateway-client.js";
import {
  INSIGHTS_ERROR_BODY,
  INSIGHTS_ERROR_TITLE,
} from "../../../insights-copy.js";
import { SKELETON_NOTE } from "../../../surface-copy.js";
import type { InsightsSummary } from "../../screen-contracts.js";
import InsightsScreen, {
  WINDOW_OPTIONS,
} from "../../screens/InsightsScreen.js";
import NoteBlock from "../../ui/NoteBlock.js";
import PanelBlock from "../../ui/PanelBlock.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../routeVitals.js";
import { PageSkeleton } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";

// Analytics route (#514, revamped for v9 in #765): reads the run rollup for a
// chosen window, resolves automation display names, deep-links a run. No
// commit — counting what already happened has nothing to write.

const DAY_MS = 86_400_000;

/** The window survives the session on the member's prefs record, shared with
 *  the assistant's starters. */
export const WINDOW_PREF_KEY = "insights.windowDays";

const DEFAULT_WINDOW_DAYS = 30;

function isWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

export function uptimeLine(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined || !Number.isFinite(uptimeMs) || uptimeMs < 0)
    return "This vault host did not report how long it has been up.";
  const days = Math.floor(uptimeMs / DAY_MS);
  if (days >= 1)
    return `The vault host has been up for ${days} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.max(1, Math.floor(uptimeMs / 3_600_000));
  return `The vault host has been up for ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

/** The app bar's count line — the window's volume and its failures. */
export function countLine(summary: InsightsSummary, days: number): string {
  const { generations, failedRuns } = summary.kpis;
  return `${generations.toLocaleString()} runs in ${days} days · ${failedRuns} failed`;
}

/** Success share + host uptime; no median duration is recorded. */
export function healthLine(
  summary: InsightsSummary,
  uptimeMs: number | undefined
): { label: string; detail: string } {
  const { generations, failedRuns } = summary.kpis;
  const succeeded = Math.max(0, generations - failedRuns);
  const pct =
    generations === 0 ? 100 : Math.round((succeeded / generations) * 100);
  return {
    detail: uptimeLine(uptimeMs),
    label: `${pct}% of runs succeeded`,
  };
}

const CSV_HEADER = "date,runs,tokens,cost_usd";

/** The daily rollup as CSV, in the order the chart draws it. */
export function insightsCsv(summary: InsightsSummary): string {
  const rows = summary.daily.map(
    (day) => `${day.date},${day.runs},${day.tokens},${day.costUsd.toFixed(4)}`
  );
  return [CSV_HEADER, ...rows].join("\n");
}

function downloadCsv(summary: InsightsSummary, days: number): void {
  const blob = new Blob([insightsCsv(summary)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `centraid-analytics-${days}d.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function InsightsRoute(): JSX.Element {
  const { navigate } = useShellActions();
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [retry, setRetry] = useState(0);

  // The persisted window arrives after the first paint; fetching before it
  // resolves is the alternative to a blank frame.
  useEffect(() => {
    let cancelled = false;
    void getUserPrefs()
      .then((prefs) => {
        const saved = prefs[WINDOW_PREF_KEY];
        if (!cancelled && isWindow(saved)) setWindowDays(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const pickWindow = useCallback((days: number): void => {
    setWindowDays(days);
    // Fire-and-forget: a preference write must never block the view.
    void saveUserPrefs({ [WINDOW_PREF_KEY]: days }).catch(() => undefined);
  }, []);

  const state = useAsyncData(async () => {
    // Health (#528) carries the resource receipt + uptime; its failure must
    // never break Analytics, so it resolves to null on any error.
    const [summary, automations, health] = await Promise.all([
      getInsightsSummary({ windowDays }),
      listAutomations().catch(() => [] as CentraidAutomationRow[]),
      getGatewayHealth().catch(() => null),
    ]);
    const nameByRef = new Map(automations.map((a) => [a.ref, a.name]));
    return {
      resourceUsage: health?.metrics?.resourceUsage,
      uptimeMs: health?.uptimeMs,
      ...summary,
      bySource: summary.bySource.map((row) =>
        row.kind === "automation"
          ? {
              ...row,
              label: nameByRef.get(row.key) ?? row.automationName ?? row.key,
            }
          : row
      ),
      recent: summary.recent.map((row) =>
        row.automationRef
          ? {
              ...row,
              label:
                nameByRef.get(row.automationRef) ??
                row.automationName ??
                row.automationRef,
            }
          : row
      ),
    };
  }, [windowDays, retry]);

  const status = state.status;
  const data = status === "ready" ? state.data : undefined;
  useEffect(() => {
    if (status === "loading") {
      publishRouteSignals("insights", { state: "loading" });
      return;
    }
    if (status === "error" || !data) {
      publishRouteSignals("insights", {
        lastReadAt: Date.now(),
        state: "error",
      });
      return;
    }
    const nothingRan = data.kpis.generations === 0 && data.recent.length === 0;
    publishRouteSignals("insights", {
      count: countLine(data, windowDays),
      ...(nothingRan ? {} : { health: healthLine(data, data.uptimeMs) }),
      state: nothingRan ? "empty" : "ready",
    });
  }, [data, status, windowDays]);

  // Export is the page's only verb: it exports the window on screen.
  useEffect(() => {
    if (!data) {
      publishRouteVerbs("insights", {});
      return;
    }
    publishRouteVerbs("insights", {
      onSecondary: () => downloadCsv(data, windowDays),
    });
  }, [data, windowDays]);

  useEffect(() => () => clearRouteSignals("insights"), []);

  return (
    <PageScroll>
      {state.status === "loading" ? (
        <>
          <PageSkeleton label="Reading the run log…" rows={6} />
          <NoteBlock>{SKELETON_NOTE}</NoteBlock>
        </>
      ) : state.status === "error" ? (
        // No rebuild trigger; the rollup rebuilds on its own schedule.
        <PanelBlock
          action={{ label: "Retry", onClick: () => setRetry((n) => n + 1) }}
          body={INSIGHTS_ERROR_BODY}
          eyebrow="Activity"
          title={INSIGHTS_ERROR_TITLE}
          tone="net"
        />
      ) : (
        <InsightsScreen
          onOpenRun={(automationId, runId) =>
            navigate({ automationId, kind: "run-view", runId })
          }
          onWindowDays={pickWindow}
          {...(state.data.resourceUsage
            ? { resourceUsage: state.data.resourceUsage }
            : {})}
          summary={state.data}
          windowDays={windowDays}
        />
      )}
    </PageScroll>
  );
}

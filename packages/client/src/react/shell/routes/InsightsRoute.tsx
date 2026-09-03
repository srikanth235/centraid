import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";
import { insightCsvFilename, insightRollupCsv } from "@centraid/design/blocks";

import {
  getGatewayHealth,
  getInsightsSummary,
  getUserPrefs,
  listAutomations,
  saveUserPrefs,
} from "../../../gateway-client.js";
import {
  INSIGHTS_DEFAULT_WINDOW_DAYS,
  INSIGHTS_ERROR_BODY,
  INSIGHTS_ERROR_TITLE,
  INSIGHTS_WINDOW_PREF_KEY,
  isInsightsWindow,
} from "../../../insights-copy.js";
import { SKELETON_NOTE } from "../../../surface-copy.js";
import type { InsightsSummary } from "../../screen-contracts.js";
import InsightsScreen from "../../screens/InsightsScreen.js";
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

export function uptimeLine(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined || !Number.isFinite(uptimeMs) || uptimeMs < 0)
    return "This vault host did not report how long it has been up.";
  const days = Math.floor(uptimeMs / DAY_MS);
  if (days >= 1)
    return `The vault host has been up for ${days} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.max(1, Math.floor(uptimeMs / 3_600_000));
  return `The vault host has been up for ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function countLine(summary: InsightsSummary, days: number): string {
  const { generations, failedRuns } = summary.kpis;
  return `${generations.toLocaleString()} runs in ${days} days · ${failedRuns} failed`;
}

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

function downloadCsv(summary: InsightsSummary, days: number): void {
  const blob = new Blob([insightRollupCsv(summary)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = insightCsvFilename(days);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function InsightsRoute(): JSX.Element {
  const { navigate } = useShellActions();
  const [windowDays, setWindowDays] = useState(INSIGHTS_DEFAULT_WINDOW_DAYS);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getUserPrefs()
      .then((prefs) => {
        const saved = prefs[INSIGHTS_WINDOW_PREF_KEY];
        if (!cancelled && isInsightsWindow(saved)) setWindowDays(saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const pickWindow = useCallback((days: number): void => {
    setWindowDays(days);
    void saveUserPrefs({ [INSIGHTS_WINDOW_PREF_KEY]: days }).catch(
      () => undefined
    );
  }, []);

  const state = useAsyncData(async () => {
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

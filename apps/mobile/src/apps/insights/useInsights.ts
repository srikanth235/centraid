// The Analytics place's data half (#765): two reads, one preference, and one
// export — nothing about layout or copy.
//
// The two reads stay independent, as they were before the revamp: usage
// (`/_insights/summary`, vault-scoped) and health (`/_gateway/health`,
// gateway-wide) can be served by different gateway versions. The SUMMARY is
// what this page is: without it there is no page, so its failure is the error
// state. Health is a qualifier — its failure costs the page its Gateway facts
// and the uptime clause of the standing line, and nothing else.
//
// The window is the page's one parameter. Changing it re-reads, which is why
// the count facts, the chart, the section metas and the axis can never
// disagree about which window they are describing: they are all derived from
// one summary that was fetched for one window.

import { useCallback, useEffect, useRef, useState } from "react";

import type { OpsState } from "../../kit/components/health-line";
import { GatewayError, resolveGatewayBase } from "../../lib/gateway";
import { fetchGatewayHealth, fetchInsightsSummary } from "../../lib/insights";
import type { GatewayHealth, InsightsSummary } from "../../lib/insights";
import { subscribeVaultLinks } from "../../lib/vault-links";
import { shareCsv } from "./insights-export";
import { DEFAULT_WINDOW_DAYS, nothingRan } from "./insights-model";
import { readWindowPref, writeWindowPref } from "./insights-window-pref";

/** What the gateway answered. `empty` is derived from it, never stored. */
export type InsightsLoad =
  | { kind: "loading" }
  /** `at` is when the answer landed. Every relative phrase on the page is
   *  measured from it rather than from `Date.now()` at render time: a clock
   *  read during render is impure, and a row that silently re-ages on an
   *  unrelated re-render claims a freshness nothing re-checked. */
  | {
      at: number;
      kind: "ready";
      summary: InsightsSummary;
      health?: GatewayHealth;
    }
  /** `reason` is the underlying failure, shown as the error panel's one fact —
   *  the panel's own body never changes, because what is safe does not. */
  | { kind: "error"; reason: string };

export interface InsightsController {
  load: InsightsLoad;
  state: OpsState;
  /** The clock every relative phrase on the page is measured from. */
  now: number;
  windowDays: number;
  setWindowDays: (days: number) => void;
  refreshing: boolean;
  exporting: boolean;
  /** A failed export, said once, above the blocks. */
  exportError: string | undefined;
  refresh: () => Promise<void>;
  retry: () => void;
  exportCsv: () => void;
}

const NOT_PAIRED = "This phone is not linked to a vault yet.";

function describe(error: unknown): string {
  return (error instanceof GatewayError || error instanceof Error) &&
    error.message
    ? error.message
    : "Your vault's home machine did not answer.";
}

async function read(
  windowDays: number,
  apply: (next: InsightsLoad) => void
): Promise<void> {
  if (!(await resolveGatewayBase().catch(() => undefined))) {
    apply({ kind: "error", reason: NOT_PAIRED });
    return;
  }
  // Health must never sink the page, so it resolves to `undefined` on any
  // failure; the summary is the page, so its failure is the error state.
  const [summaryResult, health] = await Promise.all([
    fetchInsightsSummary(windowDays).then(
      (summary) => ({ ok: true, summary }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    ),
    fetchGatewayHealth().catch(() => undefined),
  ]);
  if (!summaryResult.ok) {
    apply({ kind: "error", reason: describe(summaryResult.error) });
    return;
  }
  apply({
    at: Date.now(),
    kind: "ready",
    summary: summaryResult.summary,
    ...(health ? { health } : {}),
  });
}

/**
 * Which of the states the page is in.
 *
 * There is no `full`: Analytics does not cycle on row count, because its chip
 * row is unconditional (spec §5 — "its chip row is always shown, not gated by
 * `full`"), so a `full` state would render exactly the `ready` page. `empty`
 * is read off the summary rather than stored, so it cannot disagree with what
 * rendered.
 */
export function opsStateFor(load: InsightsLoad): OpsState {
  if (load.kind === "loading") return "loading";
  if (load.kind === "error") return "error";
  return nothingRan(load.summary) ? "empty" : "ready";
}

export function useInsights(): InsightsController {
  const [load, setLoad] = useState<InsightsLoad>({ kind: "loading" });
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | undefined>();
  // A ref, not state: the guard has to hold WITHIN a tick, or two taps on
  // Export before React re-renders would open two share sheets over one file.
  const inFlight = useRef(false);

  // The stored window arrives after the first read has already started, so a
  // member whose window is not the default sees one extra read. Waiting for
  // the preference before reading anything is the alternative to a blank
  // frame, and a blank frame is worse.
  useEffect(() => {
    let cancelled = false;
    void readWindowPref().then((saved) => {
      if (!cancelled && saved !== undefined) setWindowDays(saved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void read(windowDays, setLoad);
  }, [windowDays]);

  // Switching the active vault re-points usage at a different vault — re-read,
  // because the numbers on screen belong to the vault that was selected.
  useEffect(
    () => subscribeVaultLinks(() => void read(windowDays, setLoad)),
    [windowDays]
  );

  const pickWindow = useCallback((days: number): void => {
    setWindowDays(days);
    setLoad({ kind: "loading" });
    void writeWindowPref(days);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setExportError(undefined);
    await read(windowDays, setLoad);
    setRefreshing(false);
  }, [windowDays]);

  const retry = useCallback((): void => {
    setLoad({ kind: "loading" });
    setExportError(undefined);
    void read(windowDays, setLoad);
  }, [windowDays]);

  const exportCsv = useCallback((): void => {
    if (inFlight.current || load.kind !== "ready") return;
    inFlight.current = true;
    setExporting(true);
    setExportError(undefined);
    void shareCsv(load.summary, windowDays)
      .catch((error: unknown) => setExportError(describe(error)))
      .finally(() => {
        inFlight.current = false;
        setExporting(false);
      });
  }, [load, windowDays]);

  return {
    exportCsv,
    exportError,
    exporting,
    load,
    now: load.kind === "ready" ? load.at : 0,
    refresh,
    refreshing,
    retry,
    setWindowDays: pickWindow,
    state: opsStateFor(load),
    windowDays,
  };
}

// Analytics data half (#765): usage (`/_insights/summary`) is the page;
// health (`/_gateway/health`) is a qualifier and must never sink it.

import { useCallback, useEffect, useRef, useState } from "react";

import type { OpsState } from "../../kit/components/health-line";
import { GatewayError, resolveGatewayBase } from "../../lib/gateway";
import { fetchGatewayHealth, fetchInsightsSummary } from "../../lib/insights";
import type { GatewayHealth, InsightsSummary } from "../../lib/insights";
import { subscribeVaultLinks } from "../../lib/vault-links";
import { shareCsv } from "./insights-export";
import { DEFAULT_WINDOW_DAYS, nothingRan } from "./insights-model";
import { readWindowPref, writeWindowPref } from "./insights-window-pref";

export type InsightsLoad =
  | { kind: "loading" }
  /** `at` is when the answer landed — relative phrases measure from it, not `Date.now()` at render. */
  | {
      at: number;
      kind: "ready";
      summary: InsightsSummary;
      health?: GatewayHealth;
    }
  | { kind: "error"; reason: string };

export interface InsightsController {
  load: InsightsLoad;
  state: OpsState;
  now: number;
  windowDays: number;
  setWindowDays: (days: number) => void;
  refreshing: boolean;
  exporting: boolean;
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

/** No `full`: the chip row is always shown (spec §5). `empty` is derived, not stored. */
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
  // Ref, not state: the guard must hold within a tick or two taps open two sheets.
  const inFlight = useRef(false);

  // Stored window arrives after the first read; waiting for it is a blank frame.
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

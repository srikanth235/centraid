import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { row as automationRow } from "../../../gateway-client-contract-fixtures.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import { readVitals, resetVitals } from "../routeVitals.js";
import { readRouteHealth } from "../statusChannel.js";
import type * as TypeImport_f807xh from "./InsightsRoute.js";

type InsightsSummary = Awaited<
  ReturnType<typeof TypeImport_1gl5zx7.getInsightsSummary>
>;
type GatewayHealth = Awaited<
  ReturnType<typeof TypeImport_1gl5zx7.getGatewayHealth>
>;

const getInsightsSummary =
  vi.fn<typeof TypeImport_1gl5zx7.getInsightsSummary>();
const listAutomations = vi.fn<typeof TypeImport_1gl5zx7.listAutomations>();
const getGatewayHealth = vi.fn<typeof TypeImport_1gl5zx7.getGatewayHealth>();
const getUserPrefs = vi.fn<typeof TypeImport_1gl5zx7.getUserPrefs>();
const saveUserPrefs = vi.fn<typeof TypeImport_1gl5zx7.saveUserPrefs>();
const navigate = vi.fn<ShellActions["navigate"]>();
vi.mock(import("../../../gateway-client.js") as Promise<unknown>, () => ({
  getGatewayHealth: () => getGatewayHealth(),
  getInsightsSummary: (input?: { windowDays?: number }) =>
    getInsightsSummary(input),
  getUserPrefs: () => getUserPrefs(),
  listAutomations: () => listAutomations(),
  saveUserPrefs: (patch: Record<string, unknown>) => saveUserPrefs(patch),
}));
vi.mock(import("../actions.js") as Promise<unknown>, () => ({
  useShellActions: () => ({ navigate }),
}));

let InsightsRoute: typeof TypeImport_f807xh.default;
let insightsCsv: typeof TypeImport_f807xh.insightsCsv;
let uptimeLine: typeof TypeImport_f807xh.uptimeLine;
let root: Root | null = null;
let host: HTMLElement | null = null;

describe("InsightsRoute suite", () => {
  beforeEach(async () => {
    ({
      default: InsightsRoute,
      insightsCsv,
      uptimeLine,
    } = await import("./InsightsRoute.js"));
    getInsightsSummary.mockReset();
    listAutomations.mockReset();
    getGatewayHealth.mockReset();
    getUserPrefs.mockReset();
    saveUserPrefs.mockReset();
    navigate.mockReset();
    resetVitals();
    listAutomations.mockResolvedValue([]);
    getGatewayHealth.mockResolvedValue(health());
    getUserPrefs.mockResolvedValue({});
    saveUserPrefs.mockResolvedValue({});
  });

  async function render(): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<InsightsRoute />);
    });
    return host;
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const summary: InsightsSummary = {
    byEffort: [],
    byHarness: [],
    byModel: [],
    bySource: [] as Array<{
      key: string;
      label: string;
      kind: string;
      runs: number;
      tokens: number;
      costUsd: number;
      automationName?: string;
    }>,
    daily: [{ costUsd: 0.1, date: "2026-06-08", runs: 2, tokens: 1000 }],
    generatedAt: Date.UTC(2026, 5, 10),
    kpis: {
      appsTouched: 7,
      estimatedCostUsd: 1.4,
      failedCostUsd: 0,
      failedRuns: 3,
      forecastCostUsd: 5.1,
      generations: 42,
      harnessReportedCostUsd: 2,
      hydrationTokens: 0,
      retries: 3,
      totalCostUsd: 3.4,
      totalTokens: 128_000,
      unpricedRuns: 0,
      unreportedRuns: 0,
    },
    recent: [],
    windowDays: 30,
  };

  function health(metrics?: GatewayHealth["metrics"]): GatewayHealth {
    return {
      components: [],
      recentEvents: [],
      startedAt: "2026-07-28T00:00:00.000Z",
      status: "ok",
      uptimeMs: 21 * 86_400_000,
      ...(metrics ? { metrics } : {}),
    };
  }

  describe("InsightsRoute", () => {
    it("holds the row geometry with a skeleton, then shows the page", async () => {
      let resolveSummary!: (value: InsightsSummary) => void;
      getInsightsSummary.mockReturnValue(
        new Promise((resolve) => {
          resolveSummary = resolve;
        })
      );
      const el = await render();
      // A skeleton, never a spinner, and never a bare "Loading…" line.
      expect(el.querySelector("output")).not.toBeNull();
      expect(readVitals("insights")?.state).toBe("loading");
      await act(async () => {
        resolveSummary(summary);
      });
      expect(el.querySelector("output")).toBeNull();
      expect(el.querySelector(".page")).not.toBeNull();
    });

    it("says what failed, what is safe, and one way forward", async () => {
      getInsightsSummary.mockRejectedValue(new Error("offline"));
      const el = await render();
      const panel = el.querySelector(".panel") as HTMLElement | null;
      expect(panel?.dataset.tone).toBe("net");
      expect(el.textContent).toContain("The run log is unavailable");
      expect(el.textContent).toContain(
        "Runs are still being recorded. This page reads a rollup that is rebuilt every ten minutes, and the rebuild has not finished."
      );
      // No rebuild trigger exists to offer, so the verb is the honest one.
      expect(el.textContent).toContain("Retry");
      expect(el.textContent).not.toContain("Rebuild now");
      expect(readVitals("insights")?.state).toBe("error");
    });

    it("re-reads the rollup when the reader asks again", async () => {
      getInsightsSummary.mockRejectedValueOnce(new Error("offline"));
      getInsightsSummary.mockResolvedValue(summary);
      const el = await render();
      const retry = el.querySelector(".panel button") as HTMLButtonElement;
      await act(async () => retry.click());
      expect(getInsightsSummary).toHaveBeenCalledTimes(2);
      expect(el.querySelector(".page")).not.toBeNull();
    });

    it("publishes the count line and the health sentence together", async () => {
      getInsightsSummary.mockResolvedValue(summary);
      await render();
      expect(readVitals("insights")).toStrictEqual({
        count: "42 runs in 30 days · 3 failed",
        state: "ready",
      });
      expect(readRouteHealth()?.text).toBe(
        "93% of runs succeeded · The vault host has been up for 21 days."
      );
    });

    it("reports empty when nothing ran in the window", async () => {
      getInsightsSummary.mockResolvedValue({
        ...summary,
        kpis: { ...summary.kpis, failedRuns: 0, generations: 0 },
      });
      const el = await render();
      expect(readVitals("insights")?.state).toBe("empty");
      expect(el.textContent).toContain("Nothing has run yet");
    });

    it("restores the member's window and saves the one they pick", async () => {
      getUserPrefs.mockResolvedValue({ "insights.windowDays": 90 });
      getInsightsSummary.mockResolvedValue(summary);
      const el = await render();
      expect(getInsightsSummary).toHaveBeenLastCalledWith({ windowDays: 90 });
      const chips = [...el.querySelectorAll(".chip")] as HTMLButtonElement[];
      await act(async () => chips[0]!.click());
      expect(saveUserPrefs).toHaveBeenCalledWith({ "insights.windowDays": 7 });
      expect(getInsightsSummary).toHaveBeenLastCalledWith({ windowDays: 7 });
    });

    it("requests the default 30-day window when nothing is saved", async () => {
      getInsightsSummary.mockResolvedValue(summary);
      await render();
      expect(getInsightsSummary).toHaveBeenCalledWith({ windowDays: 30 });
    });

    it("resolves automation display names for by-source + recent rows", async () => {
      listAutomations.mockResolvedValue([
        {
          ...automationRow(),
          name: "System health check",
          ref: "system-health-check/system-health-check",
        },
      ]);
      getInsightsSummary.mockResolvedValue({
        ...summary,
        bySource: [
          {
            costUsd: 0,
            key: "system-health-check/system-health-check",
            kind: "automation",
            label: "Automation",
            runs: 1,
            tokens: 0,
          },
        ],
        recent: [
          {
            automationRef: "system-health-check/system-health-check",
            costUsd: 0,
            hydrationTokens: 0,
            kind: "automation",
            label: "ok",
            ok: true,
            runId: "r1",
            startedAt: 1_750_000_000_000,
            tokens: 0,
          },
        ],
      });
      const el = await render();
      expect(el.textContent).toContain("System health check");
    });

    it("falls back to the run-recorded automation name for a deleted automation", async () => {
      listAutomations.mockResolvedValue([]);
      getInsightsSummary.mockResolvedValue({
        ...summary,
        recent: [
          {
            automationName: "Gone Automation",
            automationRef: "gone-app/gone-auto",
            costUsd: 0,
            hydrationTokens: 0,
            kind: "automation",
            label: "ok",
            ok: true,
            runId: "r1",
            startedAt: 1_750_000_000_000,
            tokens: 0,
          },
        ],
      });
      const el = await render();
      expect(el.textContent).toContain("Gone Automation");
      expect(el.textContent).not.toContain("gone-app/gone-auto");
    });

    it("deep-links a run from its row", async () => {
      getInsightsSummary.mockResolvedValue({
        ...summary,
        recent: [
          {
            automationRef: "app/x",
            costUsd: 0,
            hydrationTokens: 0,
            kind: "automation",
            label: "A run",
            ok: true,
            runId: "r9",
            startedAt: 1_750_000_000_000,
            tokens: 0,
          },
        ],
      });
      const el = await render();
      const open = el.querySelector(".row button") as HTMLButtonElement;
      await act(async () => open.click());
      expect(navigate).toHaveBeenCalledWith({
        automationId: "app/x",
        kind: "run-view",
        runId: "r9",
      });
    });

    it("carries the gateway's measured numbers when health serves them", async () => {
      getInsightsSummary.mockResolvedValue(summary);
      getGatewayHealth.mockResolvedValue(
        health({
          outboxPending: 0,
          resourceUsage: {
            backgroundTimerFiresLastHour: 12,
            process: {
              cpuSecondsTotal: 12,
              currentRssBytes: 268_435_456,
              peakRssBytes: 268_435_456,
            },
            sinceMs: Date.now() - 3_600_000,
            subsystems: {
              backup: { bytesUploaded: 0, busyMs: 0, drains: 0 },
              harnessRuns: { busyMs: 9000, cpuSeconds: null, runs: 3 },
              replication: { busyMs: 100, bytesReplicated: 1024, passes: 1 },
              sweeps: { busyMs: 50, passes: 2 },
              workerPool: { busyMs: 1000, tasks: 4 },
            },
          },
          rssBytes: 0,
          uptimeMs: 1,
        })
      );
      const el = await render();
      expect(el.textContent).toContain("cpu time");
      expect(el.textContent).toContain("not limited by Conserve");
    });

    it("keeps Analytics working when the health fetch rejects", async () => {
      getInsightsSummary.mockResolvedValue(summary);
      getGatewayHealth.mockRejectedValue(new Error("offline"));
      const el = await render();
      expect(el.querySelector(".page")).not.toBeNull();
      expect(el.textContent).toContain("Not available from this vault host");
      expect(readRouteHealth()?.text).toContain(
        "did not report how long it has been up"
      );
    });
  });

  describe("InsightsRoute helpers", () => {
    it("exports the numbers the chart is drawn from", () => {
      expect(insightsCsv(summary)).toBe(
        "date,runs,tokens,cost_usd\n2026-06-08,2,1000,0.1000"
      );
    });

    it("says uptime at the coarsest unit that is still true", () => {
      expect(uptimeLine(21 * 86_400_000)).toBe(
        "The vault host has been up for 21 days."
      );
      expect(uptimeLine(3_600_000)).toBe(
        "The vault host has been up for 1 hour."
      );
      expect(uptimeLine(undefined)).toContain("did not report");
    });
  });
});

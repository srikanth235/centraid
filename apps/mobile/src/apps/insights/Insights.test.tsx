import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INSIGHTS_WINDOW_PREF_KEY } from "@centraid/client/insights-copy";

import { resolveTheme } from "../../kit/theme";
import type { GatewayHealth, InsightsSummary } from "../../lib/insights";
import type { InsightsScreenProps } from "../../navigation";
import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import InsightsScreen from "./Insights";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    RefreshControl: () => null,
  } as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

type Insights = typeof import("../../lib/insights");
type Gateway = typeof import("../../lib/gateway");
type FileSystem = typeof import("expo-file-system");
type SharingModule = typeof import("expo-sharing");

const wire = vi.hoisted(() => ({
  create: vi.fn<() => void>(),
  health: vi.fn<Insights["fetchGatewayHealth"]>(),
  isSharingAvailable: vi.fn<SharingModule["isAvailableAsync"]>(),
  prefs: vi.fn<Gateway["fetchJson"]>(),
  share: vi.fn<SharingModule["shareAsync"]>(),
  summary: vi.fn<Insights["fetchInsightsSummary"]>(),
  write: vi.fn<(content: string) => void>(),
}));

vi.mock(import("../../lib/insights"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchGatewayHealth: wire.health,
  fetchInsightsSummary: wire.summary,
}));
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      GatewayError: Error,
      apiHeaders: () => ({}),
      fetchJson: wire.prefs,
      requireGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
      resolveGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
    }) as unknown as Gateway
);
vi.mock(import("../../lib/vault-links"), () => ({
  subscribeVaultLinks: () => () => undefined,
}));
vi.mock(
  import("expo-file-system"),
  () =>
    ({
      File: class File {
        uri = "file:///cache/centraid-analytics-30d.csv";
        create = wire.create;
        write = wire.write;
      },
      Paths: { cache: "file:///cache" },
    }) as unknown as FileSystem
);
vi.mock(
  import("expo-sharing"),
  () =>
    ({
      isAvailableAsync: wire.isSharingAvailable,
      shareAsync: wire.share,
    }) as unknown as SharingModule
);

const colors = resolveTheme("light").colors;
const ANCHOR = Date.parse("2026-08-13T09:00:00.000Z");

function summaryOf(over: Partial<InsightsSummary> = {}): InsightsSummary {
  return {
    bySource: [
      {
        costUsd: 2,
        key: "tidy/downloads",
        kind: "automation",
        label: "Tidy downloads",
        runs: 60,
        tokens: 100,
      },
    ],
    byEffort: [{ costUsd: 2, effort: "high", runs: 60, tokens: 100 }],
    byHarness: [{ costUsd: 2, harness: "claude-code", runs: 60, tokens: 100 }],
    byModel: [],
    daily: [
      {
        costUsd: 2,
        date: "2026-08-13",
        failedCostUsd: 0,
        failedRuns: 0,
        runs: 60,
        tokens: 100,
      },
    ],
    generatedAt: ANCHOR,
    kpis: {
      appsTouched: 2,
      estimatedCostUsd: 0,
      failedCostUsd: 0.5,
      failedRuns: 2,
      forecastCostUsd: 9,
      generations: 312,
      harnessReportedCostUsd: 2,
      hydrationTokens: 0,
      quotaTokens: 0,
      retries: 0,
      totalCostUsd: 2,
      totalTokens: 100,
      unpricedRuns: 0,
      unreportedRuns: 0,
    },
    recent: [
      {
        automationRef: "tidy/downloads",
        costUsd: 0.42,
        hydrationTokens: 0,
        kind: "automation",
        label: "Tidy downloads",
        ok: false,
        runId: "run-1",
        startedAt: ANCHOR,
        tokens: 1200,
      },
    ],
    windowDays: 30,
    ...over,
  };
}

const health: GatewayHealth = {
  components: [{ component: "storage", errorCount: 0, status: "ok" }],
  metrics: {
    outboxPending: 0,
    rssBytes: 1024 * 1024,
    uptimeMs: 21 * 86_400_000,
  },
  recentEvents: [],
  startedAt: "2026-07-23T00:00:00.000Z",
  status: "ok",
  uptimeMs: 21 * 86_400_000,
};

const navigation = {
  goBack: vi.fn<() => void>(),
  navigate: vi.fn<(name: string, params?: unknown) => void>(),
} as unknown as InsightsScreenProps["navigation"];

let dispose: (() => void) | undefined;

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function settle(): Promise<void> {
  await tick();
  await tick();
  await tick();
}

async function render(): Promise<HTMLElement> {
  const mounted = mountBlock(
    <InsightsScreen
      navigation={navigation}
      route={{ key: "ins", name: "Insights" } as InsightsScreenProps["route"]}
    />
  );
  dispose = mounted.unmount;
  await settle();
  return mounted.container;
}

function textOf(container: HTMLElement): string[] {
  return nodesOf(container, "span").map((node) => node.textContent ?? "");
}

function labelled(container: HTMLElement, label: string): Element | null {
  return (
    nodesOf(container, "button").find((node) =>
      (node.textContent ?? "").includes(label)
    ) ?? null
  );
}

function ariaLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[aria-label]")].map(
    (node) => node.getAttribute("aria-label") ?? ""
  );
}

describe(InsightsScreen, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wire.summary.mockResolvedValue(summaryOf());
    wire.health.mockResolvedValue(health);
    wire.prefs.mockResolvedValue({ prefs: {} } as never);
    wire.isSharingAvailable.mockResolvedValue(true);
    wire.share.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("draws the row geometry while it reads, and says why", async () => {
    wire.summary.mockReturnValue(new Promise<InsightsSummary>(() => {}));
    const container = await render();
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton?.getAttribute("aria-label")).toBe("Reading the run log");
    expect(textOf(container)).toContain(
      "A row knows its shape before its content arrives, so nothing reflows when it does."
    );
    expect(textOf(container)).toContain("Reading vault activity");
    expect(labelled(container, "Export CSV")).toBeNull();
  });

  it("keeps the window chips when nothing has run", async () => {
    wire.summary.mockResolvedValue(
      summaryOf({
        bySource: [],
        daily: [],
        kpis: { ...summaryOf().kpis, failedRuns: 0, generations: 0 },
        recent: [],
      })
    );
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Nothing has run yet");
    expect(spans).toContain(
      "Once automations and the assistant start doing work, their volume and outcomes appear here."
    );
    expect(spans).toContain("7 days");
    expect(spans).toContain("90 days");
    expect(spans).toContain("Nothing to attend to");
  });

  it("reports a failed read as the net panel, with an honest verb", async () => {
    wire.summary.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("THIS PAGE COULD NOT LOAD");
    expect(spans).toContain("The run log is unavailable");
    expect(spans).toContain(
      "The rollup rebuilds every ten minutes; this rebuild has not finished."
    );
    expect(spans).toContain("connect ECONNREFUSED");
    expect(
      nodesOf(container, "div").some(
        (node) => styleOf(node).borderColor === colors.net
      )
    ).toBe(true);
    expect(labelled(container, "Try again")).not.toBeNull();
    expect(spans).toContain(
      "Activity could not load · your vault contents are unaffected."
    );
    expect(spans).not.toContain("30 days");
  });

  it("counts the window once without exposing machine health", async () => {
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("312 runs · 2 failed");
    expect(ariaLabels(container)).toContain(
      "Spend per day over the last 30 days"
    );
    expect(spans).toContain("15 Jul");
    expect(spans).toContain("Spend · 30 days");
    expect(spans).toContain("$2.00");
    expect(ariaLabels(container)).toContain("Spend by harness");
    expect(ariaLabels(container)).toContain("Spend by effort");
    expect(spans).toContain("claude-code");
    expect(spans).toContain("100% of spend");
    expect(spans).toContain("automations");
    expect(spans).toContain("Recent runs");
    expect(spans).toContain("Failed · Automation · $0.42 · 1.2k tokens");
    expect(spans).not.toContain("uptime");
    expect(spans).not.toContain("21d 0h");
    expect(spans.join(" ")).not.toMatch(/gateway|daemon|replica|component/iu);
    expect(spans).toContain("99% of runs succeeded · 312 runs in this window.");
  });

  it("keeps machine-health failures out of Origin Activity", async () => {
    wire.health.mockResolvedValue({
      ...health,
      components: [
        { component: "storage", errorCount: 0, status: "ok" },
        { component: "outbox", errorCount: 3, status: "error" },
      ],
    });
    const container = await render();
    const spans = textOf(container);
    expect(spans).not.toContain("1 of 2 healthy");
    expect(spans).not.toContain("Not healthy: outbox.");
    expect(labelled(container, "See what’s wrong")).toBeNull();
  });

  it("offers no verb about the gateway when nothing is wrong with it", async () => {
    const container = await render();
    expect(labelled(container, "See what’s wrong")).toBeNull();
  });

  it("opens the automation a failed run belongs to", async () => {
    const container = await render();
    press(labelled(container, "Open"));
    expect(navigation.navigate).toHaveBeenCalledWith("Automations", {
      automationRef: "tidy/downloads",
    });
  });

  it("moves the count, the chart and the axis together when the window changes", async () => {
    const container = await render();
    wire.summary.mockResolvedValue(
      summaryOf({
        kpis: { ...summaryOf().kpis, failedRuns: 0, generations: 41 },
        windowDays: 7,
      })
    );
    press(labelled(container, "7 days"));
    await settle();
    const spans = textOf(container);
    expect(wire.summary).toHaveBeenLastCalledWith(7);
    expect(spans).toContain("41 runs");
    expect(spans).toContain("7 Aug");
    expect(ariaLabels(container)).toContain(
      "Spend per day over the last 7 days"
    );
    expect(wire.prefs).toHaveBeenCalledWith(
      expect.stringContaining("/_centraid-user/prefs"),
      expect.objectContaining({
        body: JSON.stringify({ patch: { [INSIGHTS_WINDOW_PREF_KEY]: 7 } }),
        method: "PUT",
      })
    );
  });

  it("opens on the window the member last chose, wherever they chose it", async () => {
    wire.prefs.mockResolvedValue({
      prefs: { [INSIGHTS_WINDOW_PREF_KEY]: 90 },
    } as never);
    const container = await render();
    expect(wire.summary).toHaveBeenLastCalledWith(90);
    expect(ariaLabels(container)).toContain(
      "Spend per day over the last 90 days"
    );
  });

  it("hands the window that is on screen to the share sheet", async () => {
    const container = await render();
    press(labelled(container, "Export CSV"));
    await settle();
    expect(wire.write).toHaveBeenCalledWith(
      "date,runs,failed_runs,tokens,cost_usd,failed_cost_usd\n2026-08-13,60,0,100,2.0000,0.0000"
    );
    expect(wire.share).toHaveBeenCalledWith(
      "file:///cache/centraid-analytics-30d.csv",
      expect.objectContaining({ mimeType: "text/csv" })
    );
  });

  it("says so when the device cannot share at all", async () => {
    wire.isSharingAvailable.mockResolvedValue(false);
    const container = await render();
    press(labelled(container, "Export CSV"));
    await settle();
    expect(textOf(container)).toContain(
      "This device has no way to share a file, so the rollup cannot leave the app."
    );
  });

  it("offers no filled commit at all — this page writes nothing", async () => {
    const container = await render();
    const filled = nodesOf(container, "button").filter(
      (node) => styleOf(node).backgroundColor === colors.accentFill
    );
    expect(filled).toHaveLength(0);
  });
});
// @vitest-environment jsdom

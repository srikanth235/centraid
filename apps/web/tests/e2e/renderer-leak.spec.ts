/**
 * RENDERER LEAK SOAK (#842, #883). The shell is one long-lived document with no
 * served-app iframe (#799), so what an app open allocates is released by the
 * close or never. This proves the per-cycle residue is zero, NOT that a
 * multi-day session is clean.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";
import { budgetsForApp, leakBudgets } from "./leak-budgets.js";
import { installLeakProbe, readCensus } from "./leak-probe.js";
import type { LeakCensus } from "./leak-probe.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const CONTROL_SESSION = "web-e2e-control-session";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

/** Photos carries the leak class no integral counter shows — `blob:` URLs and
 *  decoded image data. */
const MEASURED_APPS = ["Tasks", "Photos"] as const;

const here = import.meta.dirname;
function reportPathFor(appName: string): string {
  return path.resolve(
    here,
    "../../../..",
    `artifacts/perf-input/renderer-leak-report-${appName.toLowerCase()}.json`
  );
}

interface HeapCensus {
  retainedNodes: number;
  heapUsedBytes: number;
}

/** No inline app mounts without a replica lease. */
async function establishSession(page: Page): Promise<void> {
  await installHarnessControlTransport(page, API_URL);
  const control = await page.evaluate(
    async ({ apiUrl, token }) => {
      const response = await fetch(`${apiUrl}/centraid/_web/control`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status };
    },
    { apiUrl: API_URL, token: ADMIN_TOKEN }
  );
  expect(control.status).toBe(200);
  await page.context().addCookies([
    {
      name: "__centraid_control",
      value: CONTROL_SESSION,
      domain: "127.0.0.1",
      path: "/centraid/_web/control",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const enrolled = await page.evaluate(async (apiUrl) => {
    const query = encodeURIComponent("/centraid/_vault/vaults");
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${query}`,
      {
        credentials: "include",
      }
    );
    const body = (await response.json()) as {
      vaults?: Array<{ vaultId: string }>;
    };
    return { status: response.status, vaultId: body.vaults?.[0]?.vaultId };
  }, API_URL);
  expect(enrolled.status).toBe(200);
  expect(enrolled.vaultId).toEqual(expect.any(String));

  await page.evaluate(
    ({ endpointId, endpointTicket, vault }) => {
      sessionStorage.removeItem("centraid.web.v1.connection");
      localStorage.setItem(
        "centraid.web.v1.connection",
        JSON.stringify({
          endpointId,
          endpointTicket,
          label: "Leak E2E",
          displayName: "Web owner",
          avatarColor: "#6f5bf6",
          vaultId: vault,
          rememberDevice: true,
        })
      );
      localStorage.setItem(
        "centraid.web.v1.settings",
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() })
      );
    },
    {
      endpointId: GATEWAY_ENDPOINT_ID,
      endpointTicket: GATEWAY_ENDPOINT_TICKET,
      vault: enrolled.vaultId!,
    }
  );
  await page.reload();
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
}

async function openPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect
    .poll(
      async () => {
        if (await palette.isVisible()) return true;
        const search = page.getByRole("button", { name: /^Search/u });
        if ((await search.count()) > 0) await search.first().click();
        else await page.keyboard.press("ControlOrMeta+k");
        return palette.isVisible();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

/** Both ends prove on `window.centraid`; the frame alone stays visible. */
async function openAndClose(page: Page, appName: string): Promise<number> {
  await openPalette(page);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(appName);
  await palette
    .getByRole("button")
    .filter({ hasText: appName })
    .first()
    .click();
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(
    page.getByText(`Loading ${appName}…`, { exact: true })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { centraid?: unknown }).centraid)
      )
    )
    .toBe(true);
  // The app's OWN subtree: the document total reads 0 delta.
  const mountedNodes = await page.evaluate(
    () => document.querySelectorAll('[data-testid="inline-app-view"] *').length
  );

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("inline-app-view")).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { centraid?: unknown }).centraid === undefined
      )
    )
    .toBe(true);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
  return mountedNodes;
}

/**
 * `collectGarbage` makes the count mean "retained", not "allocated" — TWICE,
 * WITH A BEAT BETWEEN (#883 C4). One sweep leaves the census bimodal, because
 * whether the last cycle's detached tree is gone by `getMetrics` depends on
 * work that sweep itself queues; a second sweep in the same turn does not fix
 * it, since the queued work has to actually RUN in between. A leak that
 * survives two spaced forced GCs is a leak by any reading.
 */
async function heapCensus(page: Page, cdp: CDPSession): Promise<HeapCensus> {
  await cdp.send("HeapProfiler.collectGarbage");
  // On the page's own clock: the second sweep must run AFTER the tasks the
  // first queued.
  await page.waitForTimeout(250);
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const read = (name: string): number =>
    metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    retainedNodes: read("Nodes"),
    heapUsedBytes: read("JSHeapUsedSize"),
  };
}

/**
 * One independent soak per app: the residue argument compares an app against
 * ITSELF across identical cycles, so two apps sharing one document would
 * measure only their sum.
 */
for (const appName of MEASURED_APPS) {
  test(`renderer leak soak — repeated ${appName} open/close leaves no residue`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(360_000);
    const budgets = budgetsForApp(appName);

    await installLeakProbe(page);
    await page.goto("/");
    await establishSession(page);

    // Only Chromium exposes the post-GC census.
    let cdp: CDPSession | undefined;
    if (browserName === "chromium") {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
    }

    // Sequential: parallel cycles measure a different renderer.
    let mountedSubtreeLow = Number.POSITIVE_INFINITY;
    const runCycles = async (count: number): Promise<void> => {
      if (count === 0) return;
      mountedSubtreeLow = Math.min(
        mountedSubtreeLow,
        await openAndClose(page, appName)
      );
      return runCycles(count - 1);
    };

    await runCycles(leakBudgets.warmupCycles);
    const baseline = await readCensus(page);
    const baselineHeap = cdp ? await heapCensus(page, cdp) : undefined;

    await runCycles(leakBudgets.measuredCycles);
    const final = await readCensus(page);
    const finalHeap = cdp ? await heapCensus(page, cdp) : undefined;

    const growth = (key: keyof LeakCensus): number =>
      (final[key] as number) - (baseline[key] as number);
    const heapGrowthRatio =
      baselineHeap && finalHeap && baselineHeap.heapUsedBytes > 0
        ? (finalHeap.heapUsedBytes - baselineHeap.heapUsedBytes) /
          baselineHeap.heapUsedBytes
        : 0;

    const report = {
      capturedAt: new Date().toISOString(),
      app: appName,
      engine: browserName,
      cycles: {
        warmup: leakBudgets.warmupCycles,
        measured: leakBudgets.measuredCycles,
      },
      baseline,
      final,
      growth: {
        listeners: growth("listeners"),
        intervals: growth("intervals"),
        eventSources: growth("eventSources"),
        observers: growth("observers"),
        domNodes: growth("domNodes"),
        retainedNodes:
          baselineHeap && finalHeap
            ? finalHeap.retainedNodes - baselineHeap.retainedNodes
            : null,
        heapBytes:
          baselineHeap && finalHeap
            ? finalHeap.heapUsedBytes - baselineHeap.heapUsedBytes
            : null,
        heapRatio:
          baselineHeap && finalHeap ? Number(heapGrowthRatio.toFixed(4)) : null,
      },
      mountedSubtreeLow,
    };
    const reportPath = reportPathFor(appName);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n=========== RENDERER LEAK SOAK — ${appName} ===========`);
    console.log(
      `engine: ${browserName}  cycles: ${leakBudgets.measuredCycles}`
    );
    console.log(`listeners:     ${baseline.listeners} → ${final.listeners}`);
    console.log(`  by target:   ${JSON.stringify(final.listenersByTarget)}`);
    console.log(`intervals:     ${baseline.intervals} → ${final.intervals}`);
    console.log(
      `eventSources:  ${baseline.eventSources} → ${final.eventSources}`
    );
    console.log(`observers:     ${baseline.observers} → ${final.observers}`);
    console.log(`domNodes:      ${baseline.domNodes} → ${final.domNodes}`);
    console.log(
      `app subtree:   ${mountedSubtreeLow} elements while mounted (worst cycle)`
    );
    if (baselineHeap && finalHeap) {
      console.log(
        `retainedNodes: ${baselineHeap.retainedNodes} → ${finalHeap.retainedNodes}`
      );
      console.log(
        `heapUsed:      ${baselineHeap.heapUsedBytes} → ${finalHeap.heapUsedBytes} ` +
          `(ratio ${heapGrowthRatio.toFixed(4)})`
      );
    } else {
      console.log(
        "retainedNodes / heapUsed: NOT MEASURED (no CDP on this engine)"
      );
    }
    console.log("======================================================\n");

    // Anti-vacuity: every ceiling caps GROWTH, so a nothing-run passes.
    expect(
      mountedSubtreeLow,
      "elements inside the mounted app view, worst cycle"
    ).toBeGreaterThanOrEqual(budgets.minMountedSubtreeNodes);

    // Integral: a subscription is torn down or it is not.
    expect(growth("intervals"), "live setInterval handles").toBeLessThanOrEqual(
      budgets.maxIntervalGrowth
    );
    expect(
      growth("eventSources"),
      "open EventSource connections"
    ).toBeLessThanOrEqual(budgets.maxEventSourceGrowth);
    expect(
      growth("observers"),
      "observing Mutation/Resize/Intersection observers"
    ).toBeLessThanOrEqual(budgets.maxObserverGrowth);

    expect(
      growth("listeners"),
      "listener registrations on window/document/body"
    ).toBeLessThanOrEqual(budgets.maxListenerGrowth);
    expect(
      growth("domNodes"),
      "elements attached to the document"
    ).toBeLessThanOrEqual(budgets.maxDomNodeGrowth);

    if (baselineHeap && finalHeap) {
      expect(
        finalHeap.retainedNodes - baselineHeap.retainedNodes,
        "renderer nodes retained after a forced GC (detached-subtree census)"
      ).toBeLessThanOrEqual(budgets.maxRetainedNodeGrowth);
      expect(
        heapGrowthRatio,
        "post-GC JS heap growth ratio"
      ).toBeLessThanOrEqual(budgets.maxHeapGrowthRatio);
    } else {
      test.info().annotations.push({
        type: "leak-note",
        description:
          `${browserName} exposes no CDP heap census; retained-node and heap ceilings ` +
          `were NOT asserted this run. The page-side counters above were.`,
      });
    }
  });
}

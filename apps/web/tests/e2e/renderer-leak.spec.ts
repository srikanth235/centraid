/**
 * RENDERER LEAK SOAK (#842). The shell is one long-lived document with no
 * served-app iframe (#799), so what an app open allocates is released by the
 * close or never. Thresholds live in `leak-budgets.ts`. This proves the
 * per-cycle residue is zero, NOT that a multi-day session is clean.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";
import { leakBudgets } from "./leak-budgets.js";
import { installLeakProbe, readCensus } from "./leak-probe.js";
import type { LeakCensus } from "./leak-probe.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const CONTROL_SESSION = "web-e2e-control-session";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
// A plain first-party route, so the census measures shell discipline, not app
// noise.
const APP_NAME = "Tasks";

const here = import.meta.dirname;
const REPORT_PATH = path.resolve(
  here,
  "../../../..",
  "artifacts/perf-input/renderer-leak-report.json"
);

interface HeapCensus {
  retainedNodes: number;
  heapUsedBytes: number;
}

/** An inline app cannot mount without a replica lease. */
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

/** Get the command palette up, retrying the click that can land before React. */
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

/** Prove both ends on `window.centraid` appearing and going away: the app frame
 *  alone is visible while the app is still up. */
async function openAndClose(page: Page): Promise<number> {
  await openPalette(page);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(APP_NAME);
  await palette
    .getByRole("button")
    .filter({ hasText: APP_NAME })
    .first()
    .click();
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(
    page.getByText(`Loading ${APP_NAME}…`, { exact: true })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as { centraid?: unknown }).centraid)
      )
    )
    .toBe(true);
  // The app's OWN subtree, never the document total — that has read 0 delta
  // with the app plainly up.
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

/** `collectGarbage` is what makes the count mean "retained", not "allocated". */
async function heapCensus(cdp: CDPSession): Promise<HeapCensus> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const read = (name: string): number =>
    metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    retainedNodes: read("Nodes"),
    heapUsedBytes: read("JSHeapUsedSize"),
  };
}

test("renderer leak soak — repeated app open/close leaves no residue", async ({
  page,
  browserName,
}) => {
  // Real cycles against a live gateway, far past the 60s default.
  test.setTimeout(360_000);

  await installLeakProbe(page);
  await page.goto("/");
  await establishSession(page);

  // Only Chromium exposes the post-GC census; elsewhere report NOT MEASURED.
  // On Chromium a missing CDP session is a broken rig.
  let cdp: CDPSession | undefined;
  if (browserName === "chromium") {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
  }

  // Sequential by necessity: parallelising the cycles (the `no-await-in-loop`
  // remedy) measures a different renderer.
  let mountedSubtreeLow = Number.POSITIVE_INFINITY;
  const runCycles = async (count: number): Promise<void> => {
    if (count === 0) return;
    mountedSubtreeLow = Math.min(mountedSubtreeLow, await openAndClose(page));
    return runCycles(count - 1);
  };

  await runCycles(leakBudgets.warmupCycles);
  const baseline = await readCensus(page);
  const baselineHeap = cdp ? await heapCensus(cdp) : undefined;

  await runCycles(leakBudgets.measuredCycles);
  const final = await readCensus(page);
  const finalHeap = cdp ? await heapCensus(cdp) : undefined;

  const growth = (key: keyof LeakCensus): number =>
    (final[key] as number) - (baseline[key] as number);
  const heapGrowthRatio =
    baselineHeap && finalHeap && baselineHeap.heapUsedBytes > 0
      ? (finalHeap.heapUsedBytes - baselineHeap.heapUsedBytes) /
        baselineHeap.heapUsedBytes
      : 0;

  const report = {
    capturedAt: new Date().toISOString(),
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
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("\n================ RENDERER LEAK SOAK ==================");
  console.log(`engine: ${browserName}  cycles: ${leakBudgets.measuredCycles}`);
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

  // Anti-vacuity: every ceiling below caps GROWTH, so a run that mounted
  // nothing passes them all at zero.
  expect(
    mountedSubtreeLow,
    "elements inside the mounted app view, worst cycle"
  ).toBeGreaterThanOrEqual(leakBudgets.minMountedSubtreeNodes);

  // Integral counters — a subscription is torn down or it is not.
  expect(growth("intervals"), "live setInterval handles").toBeLessThanOrEqual(
    leakBudgets.maxIntervalGrowth
  );
  expect(
    growth("eventSources"),
    "open EventSource connections"
  ).toBeLessThanOrEqual(leakBudgets.maxEventSourceGrowth);
  expect(
    growth("observers"),
    "observing Mutation/Resize/Intersection observers"
  ).toBeLessThanOrEqual(leakBudgets.maxObserverGrowth);

  // Sub-one-per-cycle counters — see the residue argument in leak-budgets.ts.
  expect(
    growth("listeners"),
    "listener registrations on window/document/body"
  ).toBeLessThanOrEqual(leakBudgets.maxListenerGrowth);
  expect(
    growth("domNodes"),
    "elements attached to the document"
  ).toBeLessThanOrEqual(leakBudgets.maxDomNodeGrowth);

  if (baselineHeap && finalHeap) {
    expect(
      finalHeap.retainedNodes - baselineHeap.retainedNodes,
      "renderer nodes retained after a forced GC (detached-subtree census)"
    ).toBeLessThanOrEqual(leakBudgets.maxRetainedNodeGrowth);
    expect(heapGrowthRatio, "post-GC JS heap growth ratio").toBeLessThanOrEqual(
      leakBudgets.maxHeapGrowthRatio
    );
  } else {
    // Honest degradation, not a silent pass.
    test.info().annotations.push({
      type: "leak-note",
      description:
        `${browserName} exposes no CDP heap census; retained-node and heap ceilings ` +
        `were NOT asserted this run. The page-side counters above were.`,
    });
  }
});

/**
 * RENDERER LEAK SOAK (issue #842, W3.5).
 *
 * The shell is a single long-lived document. #799 retired the served-app
 * iframe, so opening a bundled app is a route swap inside the SAME window and
 * nothing is torn down by a navigation any more — which means every allocation
 * an app open makes has to be released by the app close, or it is released
 * never. The desktop app and an installed PWA are opened once and left running
 * for days, so "never" is a real duration.
 *
 * The lane opens and closes one app N times and censuses what is still alive
 * between the cycles:
 *
 *   listeners      — `addEventListener` on window/document/body with no
 *                    matching removal
 *   intervals      — `setInterval` handles nobody cleared
 *   event sources  — the replica `_changes` SSE and anything like it
 *   observers      — Mutation/Resize/IntersectionObserver still observing
 *   attached nodes — elements in the document
 *   retained nodes — Chromium only, post-GC: the census that can see a
 *                    DETACHED subtree JS still holds
 *   heap           — Chromium only, post-GC, as a backstop
 *
 * The thresholds and the single argument they all come from are in
 * `leak-budgets.ts`; this file only measures and asserts.
 *
 * WHAT THIS LANE IS NOT: a multi-day soak. It proves the per-cycle residue is
 * zero, which is the property that makes a multi-day session safe; it does not
 * observe a multi-day session. A real one needs a resident host running for
 * days and is out of a PR lane's reach — see the receipt's blocked-external
 * note for the exact rig that would close it.
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
// Same subject as the waterfall probe: a plain first-party route that mounts on
// the web seat, so what the census measures is the shell's own mount/unmount
// discipline with the least app-specific noise on top.
const APP_NAME = "Tasks";

const here = import.meta.dirname;
const REPORT_PATH = path.resolve(
  here,
  "../../../..",
  "artifacts/perf-input/renderer-leak-report.json"
);

/** Chromium `Performance.getMetrics` rows this lane reads, post-GC. */
interface HeapCensus {
  retainedNodes: number;
  heapUsedBytes: number;
}

/**
 * Mint a control session, swap in the harness's enrolled device session, and
 * reload into a booted shell. Mirrors perf-waterfall.spec.ts — an inline app
 * cannot mount without a replica lease, so this bootstrap is the price of
 * measuring a real app open at all.
 */
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

/**
 * One open/close cycle, proved at both ends.
 *
 * MOUNTED is proved by the inline bridge publishing `window.centraid`, and
 * UNMOUNTED by it going away again — waiting on the app frame alone would be
 * satisfied while the app is still up (the shell's own nav renders inside
 * InlineAppRoute too), and a census taken there would measure the app rather
 * than what the app left behind.
 */
async function openAndClose(page: Page): Promise<number> {
  const homeNodes = await page.evaluate(
    () => document.querySelectorAll("*").length
  );
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
  const mountedNodes = await page.evaluate(
    () => document.querySelectorAll("*").length
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
  // How many elements the mounted app added to the document. Returned rather
  // than the absolute count because the absolute count barely moves (the shell
  // frame dominates it), so only the DELTA can testify that an app was up.
  return mountedNodes - homeNodes;
}

/**
 * Post-GC node and heap census over CDP.
 *
 * `collectGarbage` is what makes the node number mean "retained", not merely
 * "allocated": anything the renderer could collect is gone by the time the
 * metrics are read, so what remains is what something still points at.
 */
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
  // 15 real open/close cycles against a live gateway; far past the 60s default.
  test.setTimeout(360_000);

  await installLeakProbe(page);
  await page.goto("/");
  await establishSession(page);

  // Chromium exposes the post-GC census over CDP. On another engine the
  // page-side counters still run, and the report records that the two
  // Chromium-only numbers were NOT measured rather than reporting them as
  // healthy. On Chromium the session must open — an unavailable CDP session on
  // the engine that has it is a broken rig, not a reason to measure less.
  let cdp: CDPSession | undefined;
  if (browserName === "chromium") {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
  }

  // Sequential by necessity — the cycles ARE the measurement, so they may not
  // be started in parallel (`no-await-in-loop`'s remedy would measure a very
  // different renderer).
  let mountDeltaLow = Number.POSITIVE_INFINITY;
  const runCycles = async (count: number): Promise<void> => {
    if (count === 0) return;
    mountDeltaLow = Math.min(mountDeltaLow, await openAndClose(page));
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
    mountDeltaLow,
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
  console.log(`mount delta:   ${mountDeltaLow} elements (worst cycle)`);
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

  // Anti-vacuity first: every ceiling below is a ceiling on GROWTH, and a run
  // whose cycles never mounted anything would satisfy all of them at zero.
  // `openAndClose` already hard-asserts the mount and the unmount; this adds
  // the quantitative half — the app must actually have PUT something in the
  // document on every single cycle, including the worst one.
  expect(
    mountDeltaLow,
    "elements the app added to the document, worst cycle"
  ).toBeGreaterThanOrEqual(leakBudgets.minMountedNodeDelta);

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
    // Honest degradation, not a silent pass: the run says which engine could
    // not answer the two Chromium-only questions.
    test.info().annotations.push({
      type: "leak-note",
      description:
        `${browserName} exposes no CDP heap census; retained-node and heap ceilings ` +
        `were NOT asserted this run. The page-side counters above were.`,
    });
  }
});

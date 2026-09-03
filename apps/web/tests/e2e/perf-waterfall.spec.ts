// governance: allow-repo-hygiene file-size-limit (#404) one performance-waterfall suite sharing a single timing vocabulary and browser fixture; splitting the assertions would obscure the cross-flow budget comparison
import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SERVICE_WORKER_VERSION } from "../../src/sw-version.js";
import { installHarnessControlTransport } from "./control-transport.js";
import { enforceTiming, perfBudgets } from "./perf-budgets.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const CONTROL_SESSION = "web-e2e-control-session";
const APP_ID = "tasks";
const APP_NAME = "Tasks";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

const here = import.meta.dirname;
const REPORT_PATH = path.resolve(
  here,
  "../../test-results/perf-waterfall-report.json"
);
const QUALITY_REPORT_PATH = path.resolve(
  here,
  "../../../..",
  "artifacts/perf-input/pwa-waterfall-report.json"
);

interface ResourceRow {
  name: string;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  responseStatus: number | null;
  initiatorType: string;
  duration: number;
}

interface OpenSummary {
  requestCount: number;
  totalTransferBytes: number;
  totalEncodedBytes: number;
  sameOriginRequestCount: number;
  sameOriginTransferBytes: number;
  sameOriginEncodedBytes: number;
  navTransferBytes: number;
  grandTotalTransferBytes: number;
  resources: ResourceRow[];
}

interface CollectOptions {
  sinceIndex?: number;
  navigation?: boolean;
}

async function resourceMark(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("resource").length);
}

async function collect(
  page: Page,
  origin: string,
  options: CollectOptions = {}
): Promise<OpenSummary> {
  const { sinceIndex = 0, navigation = true } = options;
  const captured = (await page.evaluate(
    ({ from, withNav }) => {
      const map = (entry: PerformanceEntry) => {
        const timing = entry as PerformanceResourceTiming;
        return {
          name: timing.name,
          transferSize: timing.transferSize,
          encodedBodySize: timing.encodedBodySize,
          decodedBodySize: timing.decodedBodySize,
          responseStatus:
            "responseStatus" in timing
              ? (timing as unknown as { responseStatus: number }).responseStatus
              : null,
          initiatorType: timing.initiatorType,
          duration: timing.duration,
        };
      };
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        resources: performance
          .getEntriesByType("resource")
          .slice(from)
          .map(map),
        navTransferBytes:
          withNav && nav
            ? (nav as PerformanceNavigationTiming).transferSize
            : 0,
      };
    },
    { from: sinceIndex, withNav: navigation }
  )) as { resources: ResourceRow[]; navTransferBytes: number };

  const { resources, navTransferBytes } = captured;
  const sameOrigin = resources.filter((row) => row.name.startsWith(origin));
  const totalTransferBytes = resources.reduce(
    (sum, row) => sum + (row.transferSize || 0),
    0
  );
  return {
    requestCount: resources.length,
    totalTransferBytes,
    totalEncodedBytes: resources.reduce(
      (sum, row) => sum + (row.encodedBodySize || 0),
      0
    ),
    sameOriginRequestCount: sameOrigin.length,
    sameOriginTransferBytes: sameOrigin.reduce(
      (sum, row) => sum + (row.transferSize || 0),
      0
    ),
    sameOriginEncodedBytes: sameOrigin.reduce(
      (sum, row) => sum + (row.encodedBodySize || 0),
      0
    ),
    navTransferBytes,
    grandTotalTransferBytes: totalTransferBytes + navTransferBytes,
    resources,
  };
}

async function settleResourceTimeline(
  page: Page,
  timeout: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const a = await resourceMark(page);
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 40);
            })
        );
        return (await resourceMark(page)) === a;
      },
      { timeout }
    )
    .toBe(true);
}

async function waitForShellBundle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((e) => /\/assets\/(?:boot|index)-.*\.js$/u.test(e.name))
        ),
      { timeout: 20_000 }
    )
    .toBe(true);
  await settleResourceTimeline(page, 5_000);
}

async function establishSession(page: Page): Promise<void> {
  await installHarnessControlTransport(page, API_URL);
  const control = await page.evaluate(
    async ({ apiUrl, token }) => {
      const response = await fetch(`${apiUrl}/centraid/_web/control`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
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
      { credentials: "include" }
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
          label: "Perf E2E",
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
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
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

async function pickAppFromPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(APP_NAME);
  await palette
    .getByRole("button")
    .filter({ hasText: APP_NAME })
    .first()
    .click();
}

async function openAppAndMeasure(
  page: Page
): Promise<{ summary: OpenSummary; elapsedMs: number }> {
  const origin = new URL(page.url()).origin;
  await openPalette(page);
  await settleResourceTimeline(page, 5_000);
  const sinceIndex = await resourceMark(page);
  const started = Date.now();
  await pickAppFromPalette(page);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(
    page.getByText(`Loading ${APP_NAME}…`, { exact: true })
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.centraid)))
    .toBe(true);
  const elapsedMs = Date.now() - started;
  await settleResourceTimeline(page, 10_000);
  const summary = await collect(page, origin, {
    sinceIndex,
    navigation: false,
  });
  return { summary, elapsedMs };
}

function openBytes(s: OpenSummary): number {
  return s.sameOriginTransferBytes + s.navTransferBytes;
}

async function goHome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("inline-app-view")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.centraid === undefined))
    .toBe(true);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
}

test("app-open waterfall — shell + inline app route, cold vs warm", async ({
  page,
}) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await waitForShellBundle(page);
  const shellCold = await collect(page, origin);

  await establishSession(page);
  const shellWarm = await collect(page, origin);
  const shellByteRatio = shellCold.sameOriginTransferBytes
    ? shellWarm.sameOriginTransferBytes / shellCold.sameOriginTransferBytes
    : 0;

  const cold = await openAppAndMeasure(page);
  await goHome(page);
  const warm = await openAppAndMeasure(page);
  const appByteRatio = cold.summary.sameOriginEncodedBytes
    ? warm.summary.sameOriginEncodedBytes / cold.summary.sameOriginEncodedBytes
    : 0;

  const openReport = (label: string, s: OpenSummary, elapsedMs: number) => ({
    label,
    requestCount: s.sameOriginRequestCount,
    totalRequestCount: s.requestCount,
    resourceTransferBytes: s.sameOriginTransferBytes,
    navTransferBytes: s.navTransferBytes,
    grandTotalTransferBytes: openBytes(s),
    encodedBodyBytes: s.sameOriginEncodedBytes,
    elapsedMs,
    resources: s.resources
      .filter((row) => row.name.startsWith(origin))
      .map((row) => ({
        name: row.name,
        transferSize: row.transferSize,
        encodedBodySize: row.encodedBodySize,
        status: row.responseStatus,
      })),
  });

  const report = {
    capturedAt: new Date().toISOString(),
    harness: { apiUrl: API_URL, appId: APP_ID },
    shell: {
      cold: {
        requestCount: shellCold.sameOriginRequestCount,
        transferBytes: shellCold.sameOriginTransferBytes,
      },
      warm: {
        requestCount: shellWarm.sameOriginRequestCount,
        transferBytes: shellWarm.sameOriginTransferBytes,
      },
      warmToColdByteRatio: Number(shellByteRatio.toFixed(3)),
    },
    appOpen: {
      cold: openReport("cold", cold.summary, cold.elapsedMs),
      warm: openReport("warm", warm.summary, warm.elapsedMs),
      warmToColdByteRatio: Number(appByteRatio.toFixed(3)),
    },
  };
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.mkdir(path.dirname(QUALITY_REPORT_PATH), { recursive: true });
  await Promise.all(
    [REPORT_PATH, QUALITY_REPORT_PATH].map((file) =>
      fs.writeFile(file, JSON.stringify(report, null, 2))
    )
  );

  console.log("\n================ PWA WATERFALL SUMMARY ================");
  console.log(
    `shell cold:  requests=${shellCold.sameOriginRequestCount} transfer=${shellCold.sameOriginTransferBytes}B`
  );
  console.log(
    `shell warm:  requests=${shellWarm.sameOriginRequestCount} transfer=${shellWarm.sameOriginTransferBytes}B ` +
      `(ratio ${report.shell.warmToColdByteRatio})`
  );
  console.log(
    `app cold:    requests=${cold.summary.sameOriginRequestCount} transfer=${cold.summary.sameOriginTransferBytes}B ` +
      `encoded=${cold.summary.sameOriginEncodedBytes}B (all-origin requests=${cold.summary.requestCount}) ${cold.elapsedMs}ms`
  );
  console.log(
    `app warm:    requests=${warm.summary.sameOriginRequestCount} transfer=${warm.summary.sameOriginTransferBytes}B ` +
      `encoded=${warm.summary.sameOriginEncodedBytes}B (all-origin requests=${warm.summary.requestCount}) ${warm.elapsedMs}ms`
  );
  console.log(
    `app warm/cold encoded-byte ratio: ${report.appOpen.warmToColdByteRatio}`
  );
  console.log("======================================================\n");

  expect(
    shellCold.sameOriginTransferBytes,
    "cold shell measured (>0 bytes)"
  ).toBeGreaterThan(0);
  expect(
    shellCold.sameOriginRequestCount,
    "cold shell request count"
  ).toBeLessThanOrEqual(perfBudgets.shell.maxRequests);
  expect(
    shellCold.sameOriginTransferBytes,
    "cold shell transfer bytes"
  ).toBeLessThanOrEqual(perfBudgets.shell.maxTransferBytes);
  expect(shellByteRatio, "shell warm/cold byte ratio").toBeLessThanOrEqual(
    perfBudgets.shell.maxWarmToColdByteRatio
  );

  expect(
    cold.summary.sameOriginEncodedBytes,
    "cold app open measured (>=floor encoded bytes)"
  ).toBeGreaterThanOrEqual(perfBudgets.appOpen.cold.minEncodedBytes);
  expect(
    cold.summary.sameOriginRequestCount,
    "cold app request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxRequests);
  expect(
    cold.summary.requestCount,
    "cold app all-origin request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxTotalRequests);
  expect(
    cold.summary.sameOriginEncodedBytes,
    "cold app encoded bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxEncodedBytes);
  expect(
    openBytes(cold.summary),
    "cold app transfer bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxTransferBytes);
  expect(
    warm.summary.sameOriginRequestCount,
    "warm app request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxRequests);
  expect(
    warm.summary.requestCount,
    "warm app all-origin request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxTotalRequests);
  expect(
    warm.summary.sameOriginEncodedBytes,
    "warm app encoded bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxEncodedBytes);
  expect(
    openBytes(warm.summary),
    "warm app transfer bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxTransferBytes);
  expect(appByteRatio, "app warm/cold encoded byte ratio").toBeLessThanOrEqual(
    perfBudgets.appOpen.maxWarmToColdByteRatio
  );

  for (const [phase, elapsed, ceiling] of [
    ["cold", cold.elapsedMs, perfBudgets.timing.coldOpenMsSoftCeiling],
    ["warm", warm.elapsedMs, perfBudgets.timing.warmOpenMsSoftCeiling],
  ] as const) {
    if (elapsed > ceiling) {
      const message = `${phase} open ${elapsed}ms > soft ceiling ${ceiling}ms`;
      if (enforceTiming) expect(elapsed, message).toBeLessThanOrEqual(ceiling);
      else console.warn(`[perf][soft] ${message}`);
    }
  }
});

test("sw tunnel cache — warm re-open collapses relay round trips and bytes", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async (url) => {
    await navigator.serviceWorker.register(url);
    await navigator.serviceWorker.ready;
  }, `/sw.js?v=${SERVICE_WORKER_VERSION}`);
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);

  await page.evaluate(() => {
    interface Tally {
      calls: number;
      bytes: number;
    }
    (window as unknown as { __tunnel: Tally }).__tunnel = {
      calls: 0,
      bytes: 0,
    };
    const ASSET_BODY = "a".repeat(4096);
    const BLOB_BODY = "b".repeat(8192);
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event.data as {
        type?: string;
        target?: string;
        headers?: Record<string, string>;
      };
      const port = event.ports[0];
      if (!port) return;
      if (msg?.type === "centraid:iroh-claim") {
        port.postMessage({ type: "claim" });
        return;
      }
      if (msg?.type !== "centraid:iroh-request" || !msg.target) return;
      const tally = (window as unknown as { __tunnel: Tally }).__tunnel;
      tally.calls += 1;
      const ifNoneMatch = msg.headers?.["if-none-match"] ?? null;
      const isBlob = msg.target.includes("/_vault/blobs/");

      if (
        (!isBlob && ifNoneMatch === '"perf-etag"') ||
        (isBlob && ifNoneMatch === '"perf-blob-etag"')
      ) {
        port.postMessage({ type: "head", status: 304, headers: {} });
        port.postMessage({ type: "end" });
        return;
      }
      const body = new TextEncoder().encode(isBlob ? BLOB_BODY : ASSET_BODY);
      tally.bytes += body.length;
      port.postMessage({
        type: "head",
        status: 200,
        headers: isBlob
          ? {
              "content-type": "application/octet-stream",
              "content-length": String(body.length),
              "cache-control": "private,max-age=31536000,immutable",
              etag: '"perf-blob-etag"',
            }
          : {
              "content-type": "text/javascript",
              "content-length": String(body.length),
              "cache-control": "private,no-cache",
              etag: '"perf-etag"',
            },
      });
      const buffer = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength
      );
      port.postMessage({ type: "chunk", body: buffer }, [buffer]);
      port.postMessage({ type: "end" });
    });
  });

  const assetUrl = "/__centraid_iroh__/d-perf/centraid/perf-app/app.js";
  const blobUrl = "/__centraid_iroh__/d-perf/centraid/_vault/blobs/perf-sha";

  const read = (u: string) =>
    page.evaluate((url) => fetch(url).then((r) => r.text()), u);
  const tunnel = () =>
    page.evaluate(
      () =>
        (window as unknown as { __tunnel: { calls: number; bytes: number } })
          .__tunnel
    );
  const reset = () =>
    page.evaluate(() => {
      (
        window as unknown as { __tunnel: { calls: number; bytes: number } }
      ).__tunnel = {
        calls: 0,
        bytes: 0,
      };
    });

  expect(await read(assetUrl)).toBe("a".repeat(4096));
  expect(await read(blobUrl)).toBe("b".repeat(8192));
  const cold = await tunnel();

  await expect
    .poll(
      async () => {
        const a = (await tunnel()).calls;
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 40);
            })
        );
        return (await tunnel()).calls === a;
      },
      { timeout: 5_000 }
    )
    .toBe(true);
  await reset();

  expect(await read(assetUrl)).toBe("a".repeat(4096));
  expect(await read(blobUrl)).toBe("b".repeat(8192));
  await expect
    .poll(async () => (await tunnel()).calls, { timeout: 5_000 })
    .toBeGreaterThan(0);
  const warm = await tunnel();

  console.log(
    `\n[sw-tunnel] cold: calls=${cold.calls} bytes=${cold.bytes} | warm: calls=${warm.calls} bytes=${warm.bytes}\n`
  );

  const byteRatio = cold.bytes ? warm.bytes / cold.bytes : 0;
  const callRatio = cold.calls ? warm.calls / cold.calls : 0;
  expect(byteRatio, "warm/cold tunnel byte ratio").toBeLessThanOrEqual(
    perfBudgets.swTunnelCache.maxWarmToColdByteRatio
  );
  expect(callRatio, "warm/cold tunnel call ratio").toBeLessThanOrEqual(
    perfBudgets.swTunnelCache.maxWarmToColdRequestRatio
  );
});

test("iroh pool — connects stay far below streams (or contract is present)", async ({
  page,
}) => {
  await page.goto("/");

  const hasInstrumentation = await page
    .evaluate(
      () =>
        typeof (globalThis as { __centraidIrohStats?: unknown })
          .__centraidIrohStats
    )
    .then((t) => t === "object");
  test.skip(
    !hasInstrumentation,
    "iroh instrumentation absent from the built bundle — run `vite build` for a fresh dist"
  );

  await page.evaluate(() => {
    localStorage.setItem(
      "centraid.web.v1.connection",
      JSON.stringify({
        endpointId: "perf-probe-gateway",
        endpointTicket: "perf-probe-ticket",
        label: "Perf iroh probe",
        displayName: "probe",
        avatarColor: "#6f5bf6",
      })
    );
  });

  const REQUESTS = 4;
  await page.evaluate(async (count) => {
    const probeNext = async (index: number): Promise<void> => {
      if (index >= count) return;
      try {
        await (
          window as unknown as {
            CentraidIroh: { fetch: (p: string) => Promise<Response> };
          }
        ).CentraidIroh.fetch(`/centraid/perf-probe/${index}`);
      } catch {
        // Intentionally empty.
      }
      return probeNext(index + 1);
    };
    return probeNext(0);
  }, REQUESTS);

  const stats = (await page.evaluate(
    () => (globalThis as { __centraidIrohStats?: unknown }).__centraidIrohStats
  )) as { connects: number; streams: number; reconnects: number };

  console.log(`\n[iroh-pool] ${JSON.stringify(stats)}\n`);

  expect(stats).toMatchObject({
    connects: expect.any(Number),
    streams: expect.any(Number),
    reconnects: expect.any(Number),
  });

  if (stats.streams >= perfBudgets.irohPool.minStreamsForProof) {
    const ratio = stats.connects / stats.streams;
    expect(
      ratio,
      `connects/streams (${stats.connects}/${stats.streams})`
    ).toBeLessThanOrEqual(perfBudgets.irohPool.maxConnectToStreamRatio);
  } else {
    test.info().annotations.push({
      type: "perf-note",
      description:
        "iroh endpoint could not spawn in the headless harness (no relay/WebTransport); " +
        "asserted instrumentation contract only. Live connects≪streams proof needs a real iroh rig.",
    });
  }
});

const VITALS_REPORT_PATH = path.resolve(
  here,
  "../../../..",
  "artifacts/perf-input/web-vitals-report.json"
);

interface VitalsCapture {
  lcpMs: number | null;
  clsScore: number;
  inpMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  installed: string[];
  unsupported: string[];
  paintEntries: string;
  visibility?: string;
  bodyText?: string;
}

async function installVitalsObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      lcpMs: null as number | null,
      clsScore: 0,
      inpMs: null as number | null,
      installed: [] as string[],
      unsupported: [] as string[],
    };
    (
      globalThis as unknown as { __centraidVitals: typeof state }
    ).__centraidVitals = state;

    const HANDLERS: Record<string, (entry: PerformanceEntry) => void> = {
      "largest-contentful-paint": (entry) => {
        state.lcpMs = entry.startTime;
      },
      "layout-shift": (entry) => {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput) state.clsScore += shift.value;
      },
      event: (entry) => {
        const event = entry as PerformanceEntry & { interactionId?: number };
        if (!event.interactionId) return;
        if (state.inpMs === null || entry.duration > state.inpMs)
          state.inpMs = entry.duration;
      },
    };

    const supported = new Set(PerformanceObserver.supportedEntryTypes);
    for (const [type, handle] of Object.entries(HANDLERS)) {
      if (!supported.has(type)) {
        state.unsupported.push(type);
        continue;
      }
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handle(entry);
      });
      observer.observe(
        type === "event"
          ? ({
              type,
              buffered: true,
              durationThreshold: 16,
            } as PerformanceObserverInit)
          : { type, buffered: true }
      );
      state.installed.push(type);
    }
  });
}

async function readVitals(page: Page): Promise<VitalsCapture> {
  return (await page.evaluate(() => {
    const state = (
      globalThis as unknown as {
        __centraidVitals?: {
          lcpMs: number | null;
          clsScore: number;
          inpMs: number | null;
          installed: string[];
          unsupported: string[];
        };
      }
    ).__centraidVitals;
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      lcpMs: state?.lcpMs ?? null,
      clsScore: state?.clsScore ?? 0,
      inpMs: state?.inpMs ?? null,
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      loadEventMs: nav ? nav.loadEventEnd : null,
      installed: state?.installed ?? [],
      unsupported: state?.unsupported ?? [],
      paintEntries: performance
        .getEntriesByType("paint")
        .map((entry) => `${entry.name}=${Math.round(entry.startTime)}`)
        .join(","),
    };
  })) as VitalsCapture;
}

test("web vitals — LCP / INP / CLS on a cold shell load", async ({ page }) => {
  const budgets = JSON.parse(
    await fs.readFile(
      path.resolve(here, "../../../..", "tests/experience-budgets/web.json"),
      "utf8"
    )
  ) as {
    metrics: {
      largestContentfulPaint: {
        ceilingMs?: number;
        _intendedCeilingMs?: number;
      };
      interactionToNextPaint: {
        ceilingMs?: number;
        _intendedCeilingMs?: number;
      };
      cumulativeLayoutShift: { maxScore: number };
    };
  };

  await installVitalsObservers(page);

  await page.goto("/");
  await waitForShellBundle(page);

  const anyButton = page.locator("button:visible").first();
  const clicked = await anyButton.click({ timeout: 15_000 }).then(
    () => true,
    () => false
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 250));
      })
  );

  const vitals = await readVitals(page);
  const report = {
    capturedAt: new Date().toISOString(),
    harness: { apiUrl: API_URL, appId: APP_ID },
    volume: "empty (web-e2e fixture vault, loopback, headless Chromium)",
    interactionDriven: clicked,
    vitals,
  };
  await fs.mkdir(path.dirname(VITALS_REPORT_PATH), { recursive: true });
  await fs.writeFile(VITALS_REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("\n================ WEB VITALS SUMMARY ==================");
  console.log(
    `LCP: ${vitals.lcpMs ?? "n/a"} ms   (ceiling ${budgets.metrics.largestContentfulPaint.ceilingMs})`
  );
  console.log(
    `INP: ${vitals.inpMs ?? "n/a"} ms   (ceiling ${budgets.metrics.interactionToNextPaint.ceilingMs}, interaction driven: ${clicked})`
  );
  console.log(
    `CLS: ${vitals.clsScore}          (ceiling ${budgets.metrics.cumulativeLayoutShift.maxScore})`
  );
  console.log(
    `DCL: ${vitals.domContentLoadedMs ?? "n/a"} ms   load: ${vitals.loadEventMs ?? "n/a"} ms`
  );
  console.log(`paint entries: [${vitals.paintEntries}]`);
  console.log(
    `observers installed: [${vitals.installed.join(", ")}]  unsupported: [${vitals.unsupported.join(", ")}]`
  );
  console.log("======================================================\n");

  expect(
    vitals.installed,
    `vitals observers failed to install (unsupported: ${vitals.unsupported.join(", ")})`
  ).toContain("largest-contentful-paint");

  expect(vitals.clsScore, "cumulative layout shift").toBeLessThanOrEqual(
    budgets.metrics.cumulativeLayoutShift.maxScore
  );

  if (vitals.lcpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description:
        `no largest-contentful-paint entry (paint timeline: [${vitals.paintEntries}]). ` +
        `LCP not asserted this run; tests/experience-budgets/web.json keeps it unmeasured.`,
    });
  } else {
    const lcpCeiling =
      budgets.metrics.largestContentfulPaint.ceilingMs ??
      budgets.metrics.largestContentfulPaint._intendedCeilingMs;
    expect(lcpCeiling, "LCP ceiling configured").toEqual(expect.any(Number));
    expect(vitals.lcpMs, "largest contentful paint").toBeLessThanOrEqual(
      lcpCeiling
    );
  }
  if (vitals.inpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description: `no event-timing entry recorded (interaction driven: ${clicked}); INP not asserted this run`,
    });
  } else {
    const inpCeiling =
      budgets.metrics.interactionToNextPaint.ceilingMs ??
      budgets.metrics.interactionToNextPaint._intendedCeilingMs;
    expect(inpCeiling, "INP ceiling configured").toEqual(expect.any(Number));
    expect(vitals.inpMs, "interaction to next paint").toBeLessThanOrEqual(
      inpCeiling
    );
  }
});

// governance: allow-repo-hygiene file-size-limit (#404) one performance-waterfall suite sharing a single timing vocabulary and browser fixture; splitting the assertions would obscure the cross-flow budget comparison
import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";
import { enforceTiming, perfBudgets } from "./perf-budgets.js";

// PWA fast-path waterfall probe (issue #404 workstream I). The desktop rig
// (apps/desktop/tests/e2e-live/probe-open-waterfall.mjs) measures an app open
// in the REAL Electron shell; this is its PWA sibling. It boots the same e2e
// harness gateway (tests/e2e/server.ts installs the `web-e2e` app), opens that
// app cold then warm, and captures `performance.getEntriesByType('resource')`
// from BOTH the shell page and the app iframe's own window. It also exercises
// two other levers of the fast path: the service-worker TUNNEL cache (Test B)
// and the QUIC connection pool instrumentation (Test C).
//
// All budgets live in perf-budgets.ts; this file only measures and asserts.
// The JSON report is written to test-results/ for the bundling workstream to
// diff against as it drives these numbers down.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const APP_ID = "web-e2e";
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
  // Cross-origin resources report 0 transfer/body sizes without a
  // Timing-Allow-Origin header, so track same-origin totals separately — those
  // are the honest byte numbers.
  sameOriginRequestCount: number;
  sameOriginTransferBytes: number;
  // The HTML document itself is a `navigation` entry, not a `resource`. For the
  // app iframe (whose only "asset" is often the inlined-runtime doc) this is
  // the byte number that matters, so include it in the grand total.
  navTransferBytes: number;
  grandTotalTransferBytes: number;
  resources: ResourceRow[];
}

// Pull the resource + navigation timeline out of a page or iframe window.
async function collect(
  target: Page | Frame,
  origin: string
): Promise<OpenSummary> {
  const captured = (await target.evaluate(() => {
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
      resources: performance.getEntriesByType("resource").map(map),
      navTransferBytes: nav
        ? (nav as PerformanceNavigationTiming).transferSize
        : 0,
    };
  })) as { resources: ResourceRow[]; navTransferBytes: number };

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
    navTransferBytes,
    grandTotalTransferBytes: totalTransferBytes + navTransferBytes,
    resources,
  };
}

// Wait until the dynamically-imported boot chunk has actually landed in the
// resource timeline, so a shell measurement taken right after doesn't race the
// bundle's arrival.
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
  // readyState is already 'complete' once waitForLoadState('load') resolves.
  // Poll resource-timing until the count is stable so trailing CSS/token
  // chunks are counted (same pattern as the SWR settle below).
  await expect
    .poll(
      async () => {
        const a = await page.evaluate(
          () => performance.getEntriesByType("resource").length
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 40);
            })
        );
        const b = await page.evaluate(
          () => performance.getEntriesByType("resource").length
        );
        return a === b;
      },
      { timeout: 5_000 }
    )
    .toBe(true);
}

// Mirror the working control-session bootstrap from web-pwa.spec.ts: mint a
// cookie control session, pin the connection in localStorage, reload into a
// booted shell with the app tile on Home. The caller has already done the cold
// `goto('/')` so the shell bundle could be measured before this reload.
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
  const vaultId = (control.body as { vaultId: string }).vaultId;

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
      // The fixture app is published to the app store but never *installed*
      // (no Home pin), so the shell classifies it as a DRAFT — and drafts,
      // the builder preview, and Publish are all gated behind the
      // `builderEnabled` dev flag (issue #434, default false). ensureInstalled()
      // below drives exactly those builder surfaces, so opt the harness in.
      localStorage.setItem(
        "centraid.web.v1.settings",
        JSON.stringify({
          onboardingCompletedAt: new Date().toISOString(),
          builderEnabled: true,
        })
      );
    },
    {
      endpointId: GATEWAY_ENDPOINT_ID,
      endpointTicket: GATEWAY_ENDPOINT_TICKET,
      vault: vaultId,
    }
  );
  await page.reload();
  await expect(page.locator(`[data-app-id="${APP_ID}"]`).first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
}

// Open the installed app from Home and measure the iframe waterfall from the
// iframe's OWN origin (cross-origin timing from the shell would read 0 bytes).
// The very first tile click opens a builder PREVIEW; a Publish promotes it to
// the installed `iframe[title="app"]` path a user actually re-opens. We
// deliberately do NOT invoke `window.centraid.read` — the asset waterfall is
// the subject, and the query runtime is a separate concern.
async function ensureInstalled(page: Page): Promise<void> {
  await page
    .locator(`[data-app-id="${APP_ID}"] [data-testid="app-tile"]`)
    .first()
    .click();
  const preview = page.frameLocator('iframe[title="App preview"]');
  await expect(preview.locator("#ready")).toHaveText("generated app ready");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/added to Home/iu).first()).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator(`[data-app-id="${APP_ID}"]`).first()).toBeVisible();
}

async function openInstalledAndMeasure(
  page: Page
): Promise<{ summary: OpenSummary; elapsedMs: number }> {
  const started = Date.now();
  await page
    .locator(`[data-app-id="${APP_ID}"] [data-testid="app-tile"]`)
    .first()
    .click();
  const iframe = await page.waitForSelector('iframe[title="app"]', {
    state: "attached",
    timeout: 30_000,
  });
  const frame = await iframe.contentFrame();
  expect(frame).not.toBeNull();
  // Static markup paints before the iframe's network settles. The app runtime
  // holds a long-lived `_changes` SSE, so networkidle never settles. Poll
  // resource-timing until the count is stable so late fetch() assets are
  // included (readyState alone is already complete by #ready paint).
  await page
    .frameLocator('iframe[title="app"]')
    .locator("#ready")
    .waitFor({ state: "visible" });
  await expect
    .poll(
      async () => {
        const count = () =>
          frame!
            .evaluate(() => performance.getEntriesByType("resource").length)
            .catch(() => -1);
        const a = await count();
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              setTimeout(resolve, 40);
            })
        );
        const b = await count();
        return a >= 0 && a === b;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
  const origin = new URL(frame!.url()).origin;
  const summary = await collect(frame!, origin);
  return { summary, elapsedMs: Date.now() - started };
}

async function goHome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator(`[data-app-id="${APP_ID}"]`).first()).toBeVisible();
}

test("app-open waterfall — shell + iframe, cold vs warm (real installed app)", async ({
  page,
}) => {
  // ---- Shell: COLD load ----------------------------------------------------
  // First visit against an empty cache — this is the shell bundle cost (the
  // ~700KB boot chunk dominates), the number the bundling workstream targets.
  await page.goto("/");
  await waitForShellBundle(page);
  const shellCold = await collect(page, new URL(page.url()).origin);

  // ---- Shell: WARM load ----------------------------------------------------
  // establishSession() reloads into a booted, signed-in shell; the SW shell
  // cache + browser HTTP cache should serve the same bundle for ~0 bytes.
  await establishSession(page);
  const shellWarm = await collect(page, new URL(page.url()).origin);
  const shellByteRatio = shellCold.sameOriginTransferBytes
    ? shellWarm.sameOriginTransferBytes / shellCold.sameOriginTransferBytes
    : 0;

  // ---- App iframe: cold then warm open -------------------------------------
  await ensureInstalled(page);
  const cold = await openInstalledAndMeasure(page);
  await goHome(page);
  const warm = await openInstalledAndMeasure(page);
  const appByteRatio = cold.summary.grandTotalTransferBytes
    ? warm.summary.grandTotalTransferBytes /
      cold.summary.grandTotalTransferBytes
    : 0;

  const openReport = (label: string, s: OpenSummary, elapsedMs: number) => ({
    label,
    requestCount: s.requestCount,
    resourceTransferBytes: s.totalTransferBytes,
    navTransferBytes: s.navTransferBytes,
    grandTotalTransferBytes: s.grandTotalTransferBytes,
    elapsedMs,
    resources: s.resources.map((r) => ({
      name: r.name,
      transferSize: r.transferSize,
      status: r.responseStatus,
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

  // Human-readable summary — the baseline the bundling workstream diffs against.
  console.log("\n================ PWA WATERFALL SUMMARY ================");
  console.log(
    `shell cold:  requests=${shellCold.sameOriginRequestCount} transfer=${shellCold.sameOriginTransferBytes}B`
  );
  console.log(
    `shell warm:  requests=${shellWarm.sameOriginRequestCount} transfer=${shellWarm.sameOriginTransferBytes}B ` +
      `(ratio ${report.shell.warmToColdByteRatio})`
  );
  console.log(
    `app cold:    requests=${cold.summary.requestCount} resource=${cold.summary.totalTransferBytes}B ` +
      `nav=${cold.summary.navTransferBytes}B total=${cold.summary.grandTotalTransferBytes}B ${cold.elapsedMs}ms`
  );
  console.log(
    `app warm:    requests=${warm.summary.requestCount} resource=${warm.summary.totalTransferBytes}B ` +
      `nav=${warm.summary.navTransferBytes}B total=${warm.summary.grandTotalTransferBytes}B ${warm.elapsedMs}ms`
  );
  console.log(
    `app warm/cold total ratio: ${report.appOpen.warmToColdByteRatio}`
  );
  console.log("======================================================\n");

  // ---- Hard budgets (request count + bytes) --------------------------------
  // Cold shell is the headline cost. Assert we actually measured a cold load
  // (non-zero bytes) so a silent regression to "measured warm" can't pass.
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
  // Warm shell must be a small fraction of cold — the SW/HTTP cache working.
  expect(shellByteRatio, "shell warm/cold byte ratio").toBeLessThanOrEqual(
    perfBudgets.shell.maxWarmToColdByteRatio
  );

  expect(
    cold.summary.requestCount,
    "cold app request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxRequests);
  expect(
    cold.summary.grandTotalTransferBytes,
    "cold app transfer bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxTransferBytes);
  expect(
    warm.summary.requestCount,
    "warm app request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxRequests);
  expect(
    warm.summary.grandTotalTransferBytes,
    "warm app transfer bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.warm.maxTransferBytes);
  expect(appByteRatio, "app warm/cold byte ratio").toBeLessThanOrEqual(
    perfBudgets.appOpen.maxWarmToColdByteRatio
  );

  // ---- Soft timing (log-only unless enforceTiming) -------------------------
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

// ---------------------------------------------------------------------------
// Test B — service-worker TUNNEL cache. The page plays the tunnel-bridge role
// (as web-pwa-cache.spec.ts does) so this runs without the Iroh WASM. A warm
// re-open must be served from the SW cache: bridge round trips and
// tunnel-fetched bytes both collapse, proving the wave-1 SW-caching win.
// ---------------------------------------------------------------------------
test("sw tunnel cache — warm re-open collapses relay round trips and bytes", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);

  // A bridge that streams a real, sized body for a fresh request and a 304
  // (empty body) for a validated one — and tallies bytes streamed per call.
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
        // Validated authorization/content: 304, no body bytes on the wire.
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

  // Durable bridge ids are the only scopes allowed to persist cache entries.
  // Ephemeral ids intentionally stay cache-blind, so use the remembered-device
  // prefix that production mints for the cache performance probe.
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

  // Cold: both fetches reach the bridge and stream full bodies.
  expect(await read(assetUrl)).toBe("a".repeat(4096));
  expect(await read(blobUrl)).toBe("b".repeat(8192));
  const cold = await tunnel();

  // Let the background asset revalidation (SWR) settle — poll until the tunnel
  // call counter is stable across two samples — then reset the tally so it
  // doesn't leak into the warm measurement.
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

  // Warm: both bodies are served from cache; conditional checks reach the
  // bridge with zero body bytes so revocation remains observable.
  expect(await read(assetUrl)).toBe("a".repeat(4096));
  expect(await read(blobUrl)).toBe("b".repeat(8192));
  // Poll until the warm path has recorded at least one tunnel observation.
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

// ---------------------------------------------------------------------------
// Test C — QUIC connection pool instrumentation. Proves the transport reuses
// one endpoint CONNECT across many request STREAMS via globalThis
// .__centraidIrohStats. A live proof needs a real iroh endpoint (WebTransport
// to a relay); when the headless harness can't spawn one, we still assert the
// instrumentation CONTRACT is present so a regression that drops the counters
// is caught. Run against a FRESH `vite build` (the committed dist is gitignored
// and may predate this instrumentation).
// ---------------------------------------------------------------------------
test("iroh pool — connects stay far below streams (or contract is present)", async ({
  page,
}) => {
  await page.goto("/");

  // The bundle initializes the counter object at boot (installIrohServiceWorkerBridge).
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

  // Configure an iroh connection so window.CentraidIroh.fetch drives the real
  // transport. There is no live gateway, so each request fails after opening a
  // stream on the pooled endpoint — exactly the signal we count.
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
        /* expected: no live gateway. The stream was still opened + counted. */
      }
      return probeNext(index + 1);
    };
    return probeNext(0);
  }, REQUESTS);

  const stats = (await page.evaluate(
    () => (globalThis as { __centraidIrohStats?: unknown }).__centraidIrohStats
  )) as { connects: number; streams: number; reconnects: number };

  console.log(`\n[iroh-pool] ${JSON.stringify(stats)}\n`);

  // Contract: the counter object always has the three numeric fields.
  expect(stats).toMatchObject({
    connects: expect.any(Number),
    streams: expect.any(Number),
    reconnects: expect.any(Number),
  });

  if (stats.streams >= perfBudgets.irohPool.minStreamsForProof) {
    // Live proof: many streams rode a handful of connects.
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

// ---------------------------------------------------------------------------
// Test D — WEB VITALS (issue #659 R3a). Until this landed, the only thing the
// PWA rig measured was BYTES: request counts and transfer sizes, which are
// machine cost. A shell can move its whole bundle behind a lazy chunk, satisfy
// every byte ceiling, and still paint late — LCP/INP/CLS are what the owner
// actually experiences, and nothing in the repo captured them.
//
// The observers are installed via addInitScript so they exist BEFORE the
// document runs: a PerformanceObserver attached after paint sees a truncated
// timeline (`buffered: true` helps for LCP but not for `event`), and a vital
// measured from a late observer is a number with no relationship to the user's
// experience.
//
// Ceilings live in tests/experience-budgets/web.json (Core Web Vitals "good"
// thresholds — see that file's _provenance for why they are standard-derived
// and not fixture-derived). The report is published for the nightly perf lane
// at artifacts/perf-input/web-vitals-report.json.
// ---------------------------------------------------------------------------

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

/**
 * Install the three vitals observers before any document script runs.
 *
 * Every entry type is checked against `PerformanceObserver.supportedEntryTypes`
 * and the outcome recorded, because the failure that actually happens is an
 * observer that silently never fires: a probe reporting `LCP: null` is
 * indistinguishable from a fast page unless it can say WHY the number is
 * missing. A policy table keyed by entry type keeps the three cases from
 * drifting apart.
 */
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
      // Last LCP candidate wins — the metric is the LARGEST paint, and later
      // candidates supersede earlier ones by definition.
      "largest-contentful-paint": (entry) => {
        state.lcpMs = entry.startTime;
      },
      "layout-shift": (entry) => {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        // Shifts within 500 ms of an input are intentional (a menu opening),
        // not the janky reflow CLS exists to catch. The spec excludes them and
        // so must we, or every deliberate interaction inflates the score.
        if (!shift.hadRecentInput) state.clsScore += shift.value;
      },
      event: (entry) => {
        const event = entry as PerformanceEntry & { interactionId?: number };
        // interactionId > 0 marks an entry belonging to a real user
        // interaction; INP is the worst such latency, so track the max.
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
      // 16 ms is the lowest threshold the event-timing spec honours; 0 is
      // silently clamped to it, so state the real value.
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
      // Diagnostic, not decoration: `first-paint` without
      // `first-contentful-paint` is exactly the state this harness lands in,
      // and without it a null LCP is unattributable.
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
      largestContentfulPaint: { ceilingMs: number };
      interactionToNextPaint: { ceilingMs: number };
      cumulativeLayoutShift: { maxScore: number };
    };
  };

  await installVitalsObservers(page);

  // ---- Cold shell, empty cache ---------------------------------------------
  await page.goto("/");
  await waitForShellBundle(page);

  // ---- One deliberate interaction so INP exists at all ---------------------
  // INP is undefined without an interaction; a test that reported "INP: null,
  // passed" would be the vacuous green this rig exists to prevent, so drive a
  // real click on whatever interactive control the cold shell offers and record
  // explicitly when the browser still logged no event-timing entry.
  const anyButton = page.locator("button:visible").first();
  const clicked = await anyButton.click({ timeout: 15_000 }).then(
    () => true,
    () => false
  );
  // Event-timing entries are reported on the next frame after the interaction.
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
    // The single most important field in this file: these numbers were taken
    // against an EMPTY fixture vault on loopback, so they bound the shell's own
    // boot cost and nothing else. See tests/experience-budgets/README.md.
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

  // A probe that cannot install its observer must say so rather than report a
  // missing number as a fast page.
  expect(
    vitals.installed,
    `vitals observers failed to install (unsupported: ${vitals.unsupported.join(", ")})`
  ).toContain("largest-contentful-paint");

  // CLS is the one vital this harness measures honestly, and it is a HARD gate.
  expect(vitals.clsScore, "cumulative layout shift").toBeLessThanOrEqual(
    budgets.metrics.cumulativeLayoutShift.maxScore
  );

  // LCP/INP: assert when the browser produced them, annotate when it did not.
  //
  // MEASURED 2026-07-31 (darwin arm64, Playwright's bundled headless Chromium):
  // this harness records `first-paint` but NEVER `first-contentful-paint`, and
  // therefore never an LCP candidate, on the connect screen — even though the
  // accessibility snapshot shows fully rendered text. Both observers install
  // (`installed` proves it), so this is the renderer withholding paint timing,
  // not a broken probe. Failing the nightly on a number the browser refuses to
  // emit would make the lane permanently red and teach everyone to ignore it;
  // fabricating a pass would be worse. So: report, annotate, and keep the
  // budget entries in tests/experience-budgets/web.json marked `unmeasured`
  // until the cause is found (first suspect: content that stays visually empty
  // to the paint pipeline until a font or an opacity transition resolves).
  if (vitals.lcpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description:
        `no largest-contentful-paint entry (paint timeline: [${vitals.paintEntries}]). ` +
        `LCP not asserted this run; tests/experience-budgets/web.json keeps it unmeasured.`,
    });
  } else {
    expect(vitals.lcpMs, "largest contentful paint").toBeLessThanOrEqual(
      budgets.metrics.largestContentfulPaint.ceilingMs
    );
  }
  if (vitals.inpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description: `no event-timing entry recorded (interaction driven: ${clicked}); INP not asserted this run`,
    });
  } else {
    expect(vitals.inpMs, "interaction to next paint").toBeLessThanOrEqual(
      budgets.metrics.interactionToNextPaint.ceilingMs
    );
  }
});

// governance: allow-repo-hygiene file-size-limit (#404) one performance-waterfall suite sharing a single timing vocabulary and browser fixture; splitting the assertions would obscure the cross-flow budget comparison
import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  journeyCeiling,
  optionalJourneyCeiling,
} from "../../../../tests/helpers/journeys.js";
import { SERVICE_WORKER_VERSION } from "../../src/sw-version.js";
import { installHarnessControlTransport } from "./control-transport.js";
import { enforceTiming, perfBudgets } from "./perf-budgets.js";

// The only budgeted app-open probe (#404). An open is an inline React route
// (#799): its cost is a DELTA over the shell's own timeline. Budgets: perf-budgets.ts.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const CONTROL_SESSION = "web-e2e-control-session";
// Swapping the subject app re-seeds the appOpen ceilings — measure first.
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
  // Budget same-origin only: cross-origin gateway calls report 0 bytes.
  sameOriginRequestCount: number;
  // WIRE bytes — 0 once the SW serves the dist, so it fences only "an open
  // must not go back to the network".
  sameOriginTransferBytes: number;
  // DECODED weight, wire or cache: the column that grows with the chunk.
  sameOriginEncodedBytes: number;
  // 0 for an inline open; kept so a whole-page reuse counts its document.
  navTransferBytes: number;
  grandTotalTransferBytes: number;
  resources: ResourceRow[];
}

interface CollectOptions {
  /** Isolates an app open from the shell load before it. */
  sinceIndex?: number;
  /** Only a whole-page load has a `navigation` entry. */
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

// Trailing chunks land after paint, so count-stability is the only settle.
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
  // The count-stable poll, not readyState, bounds the measurement.
  await settleResourceTimeline(page, 5_000);
}

// The ENROLLED device session is required: replica routes reject an admin-only
// cookie with no durable device identity. Callers must do the cold `goto('/')`
// before this reload.
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

// Must stay outside the open timer: the Search button can paint before its
// listener attaches, so the click needs a retry whose 30s ceiling must never
// sit inside a 15s-budgeted measurement.
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

/** The timed action; the palette must already be open. */
async function pickAppFromPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(APP_NAME);
  await palette
    .getByRole("button")
    .filter({ hasText: APP_NAME })
    .first()
    .click();
}

// Prove the app MOUNTED, not merely routed to: a chunking change shipping a
// blank route would otherwise post the best numbers here. Deliberately no
// `window.centraid.read` — the query runtime is a separate concern.
async function openAppAndMeasure(
  page: Page
): Promise<{ summary: OpenSummary; elapsedMs: number }> {
  const origin = new URL(page.url()).origin;
  // Palette startup is shell cost: keep it before the mark and the clock.
  await openPalette(page);
  // Settle first: the palette resolves when VISIBLE, not when its imports land,
  // and a chunk in flight at the mark is charged to the open (67 KB swing).
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
  // Never use networkidle here: the replica holds a long-lived `_changes` SSE.
  await settleResourceTimeline(page, 10_000);
  const summary = await collect(page, origin, {
    sinceIndex,
    navigation: false,
  });
  return { summary, elapsedMs };
}

// Same-origin only: cross-origin calls report 0 bytes and would dilute this;
// their COUNT is fenced by `maxTotalRequests`.
function openBytes(s: OpenSummary): number {
  return s.sameOriginTransferBytes + s.navTransferBytes;
}

// Prove the app UNMOUNTED, not merely that Home painted: the Apps nav renders
// inside InlineAppRoute's ShellFrame too and `window.centraid` survives until
// React unmounts, so a warm re-open would measure the cold open's residue.
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
  // ─── Shell: COLD load ─────
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await waitForShellBundle(page);
  const shellCold = await collect(page, origin);

  // ─── Shell: WARM load ─────
  await establishSession(page);
  const shellWarm = await collect(page, origin);
  const shellByteRatio = shellCold.sameOriginTransferBytes
    ? shellWarm.sameOriginTransferBytes / shellCold.sameOriginTransferBytes
    : 0;

  // ─── Inline app route: cold then warm open ─────
  const cold = await openAppAndMeasure(page);
  await goHome(page);
  const warm = await openAppAndMeasure(page);
  // Must ride ENCODED bytes: wire bytes are 0 on both sides, so a
  // transfer-based ratio would be 0/0 and fence nothing.
  const appByteRatio = cold.summary.sameOriginEncodedBytes
    ? warm.summary.sameOriginEncodedBytes / cold.summary.sameOriginEncodedBytes
    : 0;

  const openReport = (label: string, s: OpenSummary, elapsedMs: number) => ({
    label,
    requestCount: s.sameOriginRequestCount,
    // Budgeted: extra gateway round-trips must not be invisible merely
    // because the byte fences cannot see them.
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

  // ─── Hard budgets (request count + bytes) ─────
  // Anti-vacuity: non-zero bytes prove the load was cold.
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

  // Without this floor every app-open ceiling below passes vacuously.
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

  // ─── Soft timing (log-only unless enforceTiming) ─────
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

// ─── Test B — service-worker TUNNEL cache ─────
// The page plays tunnel bridge, so this runs without the Iroh WASM.
test("sw tunnel cache — warm re-open collapses relay round trips and bytes", async ({
  page,
}) => {
  await page.goto("/");
  // The shell's own stamped script URL (iroh-transport.ts), not a bare
  // `/sw.js`: a second script URL on one scope installs a SECOND worker whose
  // crawl and claim land inside the very window this test is timing.
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

  // Must carry the remembered-device prefix: only durable bridge ids persist
  // cache entries, ephemeral ids stay cache-blind by design.
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

  // SWR revalidation must settle before the reset or it leaks into the warm run.
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

  // Conditional checks must still reach the bridge (zero body bytes), or
  // revocation stops being observable.
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

// ─── Test C — QUIC connection pool ─────
// One CONNECT reused across many STREAMS, via __centraidIrohStats. Without a
// real iroh endpoint only the instrumentation CONTRACT is asserted, so dropped
// counters are still caught. Run against a FRESH `vite build`.
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

  // Each request fails without a gateway, but the stream it opened on the
  // pooled endpoint is the signal being counted.
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

// ─── Test D — WEB VITALS (#659) ─────
// Observers must install via addInitScript, BEFORE the document runs: one
// attached after paint sees a truncated timeline (`buffered: true` covers LCP,
// not `event`). Ceilings: tests/journeys.json, web/cold-open and web/warm-switch.

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

// Record support per entry type: an observer that never fires reports `LCP:
// null`, indistinguishable from a fast page without the reason.
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
      // Last candidate wins — later ones supersede earlier by definition.
      "largest-contentful-paint": (entry) => {
        state.lcpMs = entry.startTime;
      },
      "layout-shift": (entry) => {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        // Spec excludes input-adjacent shifts; counting them lets any
        // deliberate interaction inflate the score.
        if (!shift.hadRecentInput) state.clsScore += shift.value;
      },
      event: (entry) => {
        const event = entry as PerformanceEntry & { interactionId?: number };
        // INP is the worst real interaction; interactionId 0 is not one.
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
      // 16 ms is the event-timing spec floor; 0 is silently clamped to it.
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
      // Without the paint timeline a null LCP is unattributable.
      paintEntries: performance
        .getEntriesByType("paint")
        .map((entry) => `${entry.name}=${Math.round(entry.startTime)}`)
        .join(","),
      // Both attribute a null: a hidden document emits no paint timing, and an
      // empty body means the shell never rendered rather than never painted.
      visibility: document.visibilityState,
      bodyText: (document.body.textContent ?? "").slice(0, 400),
    };
  })) as VitalsCapture;
}

/**
 * FORCE ONE PRESENTED FRAME (#922 F5).
 *
 * PaintTiming stamps `first-contentful-paint` when a frame carrying that
 * content is PRESENTED, and largest-contentful-paint has no candidate before
 * it. A headless shell driving no display presents nothing on its own, so this
 * probe could sit for its whole run on a fully rendered screen with
 * `first-paint` alone on the timeline and report `LCP: n/a` — the "missing
 * first-contentful-paint" that the journey ledger parked its
 * LCP ceiling behind. It is neither a webfont nor an unresolved transition:
 * animation frames and forced layout reads are not enough either, because they
 * never reach presentation. A capture does, which is the whole reason this
 * screenshot is taken and thrown away.
 *
 * It must run BEFORE the interaction below: Chromium stops reporting
 * largest-contentful-paint at the first input, so interacting ahead of the
 * first presented frame costs the LCP number this probe exists to produce.
 */
async function flushPaint(page: Page): Promise<void> {
  await page.screenshot({ timeout: 15_000 });
}

test("web vitals — LCP / INP / CLS on a cold shell load", async ({ page }) => {
  const COLD_OPEN_KEY = "web/cold-open/seeded-demo/ci-linux-x64-4c";
  const INTERACTION_KEY = "web/warm-switch/seeded-demo/ci-linux-x64-4c";
  const lcpCeilingMs =
    optionalJourneyCeiling(
      COLD_OPEN_KEY,
      "largestContentfulPaint",
      "ceilingMs"
    ) ??
    optionalJourneyCeiling(
      COLD_OPEN_KEY,
      "largestContentfulPaint",
      "_intendedCeilingMs"
    );
  const inpCeilingMs =
    optionalJourneyCeiling(
      INTERACTION_KEY,
      "interactionToNextPaint",
      "ceilingMs"
    ) ??
    optionalJourneyCeiling(
      INTERACTION_KEY,
      "interactionToNextPaint",
      "_intendedCeilingMs"
    );
  const clsCeiling = journeyCeiling(
    COLD_OPEN_KEY,
    "cumulativeLayoutShift",
    "maxScore"
  );

  await installVitalsObservers(page);

  await page.goto("/");
  await waitForShellBundle(page);

  await flushPaint(page);

  // The candidate must be DELIVERED to the observer before the interaction
  // below. Chromium stops reporting largest-contentful-paint at the first
  // input, and an entry still queued at that moment is dropped rather than
  // handed over late — which is why the first run of this fix reported a
  // `first-contentful-paint` on the timeline and `LCP: n/a` beside it. Giving
  // up here is not a failure: a run that produced no candidate lands in the
  // `lcpMs === null` branch below, which annotates and does not assert.
  const lcpDelivered = await page
    .waitForFunction(
      () =>
        (
          globalThis as unknown as {
            __centraidVitals?: { lcpMs: number | null };
          }
        ).__centraidVitals?.lcpMs !== null,
      undefined,
      { timeout: 10_000 }
    )
    .then(
      () => true,
      () => false
    );

  // INP is undefined without an interaction, and "INP: null, passed" is the
  // vacuous green this rig exists to prevent. The interaction is the
  // pairing-ticket field, because it is the only control the cold connect
  // screen offers that is ENABLED: "Continue" stays disabled until a ticket is
  // pasted, so `button:visible` spent its whole 15 s actionability timeout and
  // left `interactionDriven: false`. A pointer press plus a keystroke is what
  // Chromium hands an `interactionId`, which is what event-timing reports.
  const ticketField = page.getByLabel("Pairing ticket");
  const interact = async (): Promise<boolean> => {
    await ticketField.click({ timeout: 15_000 });
    await ticketField.press("c");
    return true;
  };
  const clicked = await interact().catch(() => false);
  // Event-timing entries arrive on the frame after the interaction.
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
    // A ceiling with no stated volume is not a budget
    // (tests/journeys.json `volumes`).
    volume:
      "seeded-demo (tests/journeys.json): every bundled app's demo seed plus 2,000 Atlas rows, written through the gateway's own write path",
    interactionDriven: clicked,
    lcpDelivered,
    vitals,
  };
  await fs.mkdir(path.dirname(VITALS_REPORT_PATH), { recursive: true });
  await fs.writeFile(VITALS_REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("\n================ WEB VITALS SUMMARY ==================");
  console.log(`LCP: ${vitals.lcpMs ?? "n/a"} ms   (ceiling ${lcpCeilingMs})`);
  console.log(
    `INP: ${vitals.inpMs ?? "n/a"} ms   (ceiling ${inpCeilingMs}, interaction driven: ${clicked})`
  );
  console.log(`CLS: ${vitals.clsScore}          (ceiling ${clsCeiling})`);
  console.log(
    `DCL: ${vitals.domContentLoadedMs ?? "n/a"} ms   load: ${vitals.loadEventMs ?? "n/a"} ms`
  );
  console.log(`paint entries: [${vitals.paintEntries}]`);
  console.log(
    `observers installed: [${vitals.installed.join(", ")}]  unsupported: [${vitals.unsupported.join(", ")}]`
  );
  console.log("======================================================\n");

  // A probe that cannot install its observer must fail, not report the
  // missing number as a fast page.
  expect(
    vitals.installed,
    `vitals observers failed to install (unsupported: ${vitals.unsupported.join(", ")})`
  ).toContain("largest-contentful-paint");

  // CLS is the one vital this harness measures honestly — a HARD gate.
  expect(vitals.clsScore, "cumulative layout shift").toBeLessThanOrEqual(
    clsCeiling
  );

  // Assert when the browser produced them, annotate when it did not: the
  // headless harness emits no LCP candidate while both observers install, so
  // the renderer withholds paint timing and the probe is fine. Do not make this
  // branch fail — the lane would go red on a number Chromium will not emit.
  if (vitals.lcpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description:
        `no largest-contentful-paint entry (paint timeline: [${vitals.paintEntries}], ` +
        `candidate delivered: ${lcpDelivered}, visibility: ${vitals.visibility}). ` +
        `LCP not asserted this run; tests/journeys.json keeps it unmeasured.`,
    });
  } else {
    expect(lcpCeilingMs, "LCP ceiling configured").toEqual(expect.any(Number));
    expect(vitals.lcpMs, "largest contentful paint").toBeLessThanOrEqual(
      lcpCeilingMs
    );
  }
  if (vitals.inpMs === null) {
    test.info().annotations.push({
      type: "perf-note",
      description: `no event-timing entry recorded (interaction driven: ${clicked}); INP not asserted this run`,
    });
  } else {
    expect(inpCeilingMs, "INP ceiling configured").toEqual(expect.any(Number));
    expect(vitals.inpMs, "interaction to next paint").toBeLessThanOrEqual(
      inpCeilingMs
    );
  }
});

/**
 * TAP TO APP VIEW, THE WARM SWITCH (#922 C6).
 *
 * The ledger's `desktop/warm-switch` entry measures "click an app tile → the
 * app view attaches", and it is measured on a host this container has not got:
 * Electron does not launch without a display. This is the same interval on the
 * seat that DOES run here, and it stops where the desktop probe stops: the app
 * view is ATTACHED. It does not wait for the app's host bridge or its first
 * read, and the ceiling says so — that interval belongs to the replica, and
 * this container cannot reach it (the receipt's bootstrap-loop finding).
 *
 * WARM, not cold: the scope the first open left behind is still inside its
 * grace, so this is the switch a member makes all day, and the number moves
 * when that grace stops covering it.
 */
const TAP_EVIDENCE = path.resolve(
  here,
  "../../../../artifacts/e2e/ui-impact/issue-922-web-warm-switch-app-view.png"
);

/** `goHome` proves `window.centraid` is gone; an app that never installed it
 *  has nothing to prove, so the unmount is the view leaving the tree. */
async function goHomeFromAttached(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("inline-app-view")).toBeHidden();
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
}

async function attachAppAndMeasure(page: Page): Promise<number> {
  await openPalette(page);
  // Settle if the timeline will: this measures an INTERVAL, not bytes, so a
  // timeline that never goes count-stable is noise to absorb rather than a
  // failure. It does not go stable in this container — the replica's bootstrap
  // retry keeps issuing requests behind the shell — and failing here would
  // report that loop as a slow app open.
  await settleResourceTimeline(page, 5_000).catch(() => undefined);
  const started = Date.now();
  await pickAppFromPalette(page);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  return Date.now() - started;
}

test("warm switch — tap to app view attach", async ({ page }) => {
  const KEY = "web/warm-switch/seeded-demo/ci-linux-x64-4c";
  const ceilingMs = journeyCeiling(KEY, "tapToVisualResponse", "ceilingMs");

  await page.goto("/");
  await waitForShellBundle(page);
  await establishSession(page);

  await attachAppAndMeasure(page);
  await goHomeFromAttached(page);
  const warmMs = await attachAppAndMeasure(page);

  await fs.mkdir(path.dirname(TAP_EVIDENCE), { recursive: true });
  await page.screenshot({ path: TAP_EVIDENCE, timeout: 15_000 });

  console.log(
    `\nwarm switch tap→app-view attach: ${warmMs} ms (ceiling ${ceilingMs} ms)\n`
  );
  expect(warmMs, "tap to app view attach").toBeLessThanOrEqual(ceilingMs);
});

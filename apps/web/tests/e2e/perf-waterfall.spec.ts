// governance: allow-repo-hygiene file-size-limit (#404) one performance-waterfall suite sharing a single timing vocabulary and browser fixture; splitting the assertions would obscure the cross-flow budget comparison
import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";
import { enforceTiming, perfBudgets } from "./perf-budgets.js";

// PWA fast-path waterfall probe (issue #404 workstream I). The former desktop
// exploratory rig is retired; this is the only budgeted app-open probe. It
// boots the same e2e harness gateway (tests/e2e/server.ts) and measures two
// costs off the SHELL PAGE's own performance timeline: the shell bundle (cold,
// then warm through the SW/HTTP caches) and an app open (cold, then warm).
//
// The app open is an INLINE REACT ROUTE. Issue #799 retired the served-app
// plane, so there is no app iframe and no second window to read a timeline
// from: opening a bundled app is a dynamic `import()` of that app's own lazy
// chunk (packages/client/src/react/shell/routes/inlineApps.ts) rendered by
// InlineAppRoute inside the live document. The cost of an open is therefore
// exactly the assets the shell pulls between the palette click and the mounted
// app, which this probe deltas out of
// `performance.getEntriesByType('resource')` on the shell page.
//
// It also exercises two other levers of the fast path: the service-worker
// TUNNEL cache (Test B) and the QUIC connection pool instrumentation (Test C).
//
// All budgets live in perf-budgets.ts; this file only measures and asserts.
// The JSON report is written to test-results/ for the bundling workstream to
// diff against as it drives these numbers down.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const CONTROL_SESSION = "web-e2e-control-session";
// The app-open subject: a bundled inline app, opened from the palette like any
// other. What this probe fences is the shell's per-app lazy-chunk cost, so the
// subject must be an app that HAS an interface to download.
//
// It was Tasks until #831 removed the Agenda/Notes/Tally/Tasks interfaces
// wholesale pending a ground-up redesign — their `Root` now paints one empty
// element. That left this probe measuring a hollow route: the lazy chunk fell
// to 7_346 B and tripped `minEncodedBytes`, which is exactly the vacuity the
// floor exists to catch. #831 retargeted the desktop/web offline journeys onto
// Docs for this same reason and did not reach this spec; it does now.
//
// Docs is the remaining plain first-party route that mounts on the web seat
// (Locker refuses that seat, docs/blueprint-seats.md S5; Photos is the heaviest
// and its own byte story). The appOpen ceilings below are re-seeded onto it —
// changing this app again re-seeds them once more, so measure before you swap.
const APP_ID = "docs";
const APP_NAME = "Docs";
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
  // are the honest byte numbers. In this harness the gateway answers on another
  // port, so every control/replica/query call an app makes is cross-origin and
  // byte-blind; both the shell and the app-open figures the report publishes
  // are the same-origin ones.
  sameOriginRequestCount: number;
  sameOriginTransferBytes: number;
  // `transferSize` is what came off the WIRE, and it is 0 for anything the
  // service worker answered out of Cache Storage. By the time an app can be
  // opened the SW has already precached the whole dist, so an inline app open
  // transfers 0 bytes — true, and useless as a weight fence. `encodedBodySize`
  // is populated whether a body was served from the wire or from the cache, so
  // it is the number that actually grows when an app's chunk grows. Both are
  // budgeted: transfer fences "an open must not go back to the network",
  // encoded fences "an open must not get heavier". Read encoded as DECODED
  // (raw) weight, never as a wire figure — Cache Storage holds decoded bodies.
  sameOriginEncodedBytes: number;
  // The HTML document itself is a `navigation` entry, not a `resource`, so a
  // whole-page measurement has to add it in by hand. An inline app open makes
  // NO navigation — the route swaps inside the live document — so that
  // measurement passes `navigation: false` and this stays 0 rather than
  // charging the shell document to every app open.
  navTransferBytes: number;
  grandTotalTransferBytes: number;
  resources: ResourceRow[];
}

interface CollectOptions {
  /**
   * Ignore entries recorded before this index in the page's resource timeline.
   * This is how an inline app open is isolated from the shell load that
   * preceded it: both now happen in the same window, so the open's cost is the
   * TAIL of one timeline rather than a second window's whole timeline.
   */
  sinceIndex?: number;
  /** Count the page's `navigation` entry. Only a whole-page load has one. */
  navigation?: boolean;
}

/** How many resource entries the shell page has recorded so far. */
async function resourceMark(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("resource").length);
}

// Pull the resource (and, for a whole-page load, navigation) timeline out of
// the shell page.
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

// Poll the resource timeline until its length stops growing, so a measurement
// taken right after a load or an app open still counts the trailing chunks
// (CSS, token sheets, a lazily-imported dependency) that arrive after the
// thing being waited on has painted. Shared by the shell load and the inline
// app open — both now measure the SAME window, so both settle the same way.
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
  // readyState is already 'complete' once waitForLoadState('load') resolves,
  // so the count-stable poll is what actually bounds the measurement.
  await settleResourceTimeline(page, 5_000);
}

// Mirror the working control-session bootstrap from docs-drive.spec.ts: mint a
// cookie control session, swap in the harness's deterministic ENROLLED device
// session (replica routes reject an admin-only cookie that carries no durable
// device identity, and an inline app cannot mount without a replica lease),
// pin the connection in localStorage, reload into a booted shell. The caller
// has already done the cold `goto('/')` so the shell bundle could be measured
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
  // Wait for the SW to CONTROL this client BEFORE reloading, not after. The
  // reload below is what the warm-shell measurement reads, and "warm" is
  // defined as the SW/HTTP caches answering it — so the worker has to be in
  // charge when that load's subresource requests go out. Polling for
  // `controller` only after the reload let the two race: the first visit
  // installs the SW while the page is still uncontrolled, and if the reload
  // won that race its requests bypassed the SW entirely. Most hashed assets
  // survived that on the browser HTTP cache and still reported 0 wire bytes,
  // which is why this hid for so long, but the sqlite worker script did not —
  // it came back over the wire at 67_300 B and pushed the warm/cold ratio to
  // 0.1505 against a 0.15 ceiling, failing web-e2e roughly one run in four
  // (#676). Waiting here makes the warm load genuinely service-worker-served,
  // which is the thing the ratio claims to prove.
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
  await page.reload();
  // Home is the springboard (#708); apps open via the palette, not a library
  // card. Wait for the shell, then re-confirm the service worker — a reload
  // starts the new document uncontrolled for a moment even when a live SW is
  // already claimed.
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
  // Settle before anyone measures, exactly as the cold path does: the replica
  // bootstrap spawns the sqlite worker asynchronously, so without this its
  // entry lands on either side of the warm window from run to run.
  await settleResourceTimeline(page, 5_000);
}

/**
 * Get the command palette open. Deliberately SEPARATE from the pick below, and
 * called before the open timer starts: right after a reload the Search button
 * can paint before its React listener attaches, and a click that lands in that
 * window is silently lost (same shape as docs-drive.spec.ts). Retrying that is
 * correct, but its 30s ceiling must not be inside a measurement budgeted at
 * 15s — one retry cycle would then hard-fail the timing gate on shell startup
 * jitter that has nothing to do with app-open cost.
 */
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

/** Pick the app out of an already-open palette. This is the timed action. */
async function pickAppFromPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.locator("input").fill(APP_NAME);
  await palette
    .getByRole("button")
    .filter({ hasText: APP_NAME })
    .first()
    .click();
}

// Open the inline app route and charge it everything the shell page downloaded
// while doing so. There is no second window any more, so the measurement is a
// delta over the shell's own resource timeline between the palette click and
// the mounted app.
//
// The app must be proved MOUNTED, not merely routed to: a chunking change that
// ships a blank route would otherwise post the best numbers in this file. So
// the wait is the Suspense fallback disappearing plus `window.centraid` being
// published by the inline bridge — the same liveness proof docs-drive.spec.ts
// uses. We still deliberately do NOT invoke `window.centraid.read`: the asset
// waterfall is the subject, and the query runtime is a separate concern.
async function openAppAndMeasure(
  page: Page
): Promise<{ summary: OpenSummary; elapsedMs: number }> {
  const origin = new URL(page.url()).origin;
  // Getting the palette up is shell-startup cost, not app-open cost: do it
  // before the mark and before the clock, so neither the byte delta nor the
  // timing ceiling is charged for it.
  await openPalette(page);
  // …and let its own chunks finish landing before marking. The palette resolves
  // when the dialog is VISIBLE, which does not mean its lazy imports have
  // settled; a chunk still in flight at the mark gets charged to the app open.
  // Skipping this settle produced a reproducible-looking 112_759 B with an
  // occasional 179_759 B outlier — a 67 KB swing that would flake any honest
  // ceiling. Measure from a quiet timeline instead of padding the budget.
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
  // The replica holds a long-lived `_changes` SSE, so networkidle never
  // settles; wait for the resource count to stop moving instead.
  await settleResourceTimeline(page, 10_000);
  const summary = await collect(page, origin, {
    sinceIndex,
    navigation: false,
  });
  return { summary, elapsedMs };
}

/**
 * The byte total an app open is budgeted on: SAME-ORIGIN resources plus the
 * navigation entry. Inline opens contribute no navigation, so in practice this
 * is the asset download; the field is summed rather than dropped so a future
 * whole-page measurement reusing this helper still counts its document.
 *
 * Same-origin only, deliberately: in this harness the gateway answers on
 * another port with no Timing-Allow-Origin header, so every control / replica
 * / query call an app makes reports 0 bytes and would silently dilute the
 * total. Cross-origin REQUEST COUNT is still real, and is fenced separately by
 * `maxTotalRequests` — see the budgets file.
 */
function openBytes(s: OpenSummary): number {
  return s.sameOriginTransferBytes + s.navTransferBytes;
}

/**
 * Leave the app. This must prove the app actually UNMOUNTED, not merely that
 * Home painted: `nav[aria-label="Apps"]` renders inside InlineAppRoute's own
 * ShellFrame too (Stem.tsx), so waiting on it alone is satisfied while the app
 * is still up — and `window.centraid` stays installed until React unmounts
 * (centraid-inline.ts teardown). A warm re-open measured from that state would
 * "prove liveness" against the cold open's residue instead of its own mount.
 */
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
  // ---- Shell: COLD load ----------------------------------------------------
  // First visit against an empty cache — this is the shell bundle cost (the
  // ~700KB boot chunk dominates), the number the bundling workstream targets.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await waitForShellBundle(page);
  const shellCold = await collect(page, origin);

  // ---- Shell: WARM load ----------------------------------------------------
  // establishSession() reloads into a booted, signed-in shell; the SW shell
  // cache + browser HTTP cache should serve the same bundle for ~0 bytes.
  await establishSession(page);
  const shellWarm = await collect(page, origin);
  const shellByteRatio = shellCold.sameOriginTransferBytes
    ? shellWarm.sameOriginTransferBytes / shellCold.sameOriginTransferBytes
    : 0;

  // ---- Inline app route: cold then warm open -------------------------------
  // COLD is the first open of this app in this page: the route's lazy chunk
  // (and whatever it pulls in) is fetched over the network. WARM is a second
  // open after returning Home: the module registry already holds the
  // descriptor, so a healthy warm open downloads nothing at all. That is a
  // stronger result than the retired iframe path could give — its app document
  // was `no-store`, so its warm/cold ratio sat at ~1.0 by construction — and it
  // is why the ratio ceiling is a regression fence here, not a cache proof:
  // what it catches is a change that makes re-opening an app re-download it.
  const cold = await openAppAndMeasure(page);
  // UI evidence for the subject change (#676). This probe opened Tasks until
  // #831 removed that interface, and the numbers above are now Docs' numbers —
  // a reviewer reading a re-seeded byte ceiling should be able to SEE that the
  // app the ceiling describes actually mounts, rather than take the assertions'
  // word for it. Captured on the cold open, before goHome() unmounts it.
  const uiImpactDir = path.resolve(here, "../../../../artifacts/e2e/ui-impact");
  await fs.mkdir(uiImpactDir, { recursive: true });
  await page.screenshot({
    path: path.join(uiImpactDir, "web-app-open-docs.png"),
    fullPage: true,
  });
  await goHome(page);
  const warm = await openAppAndMeasure(page);
  // The warm/cold ratio rides ENCODED bytes, not wire bytes: wire bytes are 0
  // on both sides (the SW precached the dist), so a transfer-based ratio would
  // be 0/0 and would fence nothing. On encoded bytes the ratio keeps its
  // original meaning — a re-open must not re-pay the app's payload.
  const appByteRatio = cold.summary.sameOriginEncodedBytes
    ? warm.summary.sameOriginEncodedBytes / cold.summary.sameOriginEncodedBytes
    : 0;

  // Same-origin only, for counts and for both byte columns: in this harness the
  // gateway is a different origin, so the app's control/replica/query traffic
  // reports zero bytes AND arrives in a count that varies with replica
  // scheduling. The shell's own assets are the deterministic, byte-bearing
  // subject — and they are what an app open actually costs to load.
  const openReport = (label: string, s: OpenSummary, elapsedMs: number) => ({
    label,
    requestCount: s.sameOriginRequestCount,
    // The all-origin count is published too, and budgeted: bytes are
    // unmeasurable cross-origin here, but requests are not, and an app open
    // that starts firing extra gateway round-trips must not be invisible just
    // because the byte fences cannot see them.
    totalRequestCount: s.requestCount,
    resourceTransferBytes: s.sameOriginTransferBytes,
    // Structurally 0 for an inline open — no navigation happens. Kept so the
    // report shape (and `grandTotalTransferBytes`, which every consumer reads)
    // stays stable across the served-app → inline-route change.
    navTransferBytes: s.navTransferBytes,
    grandTotalTransferBytes: openBytes(s),
    // The weight fence (see OpenSummary): decoded body bytes, wire or cache.
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

  // The same anti-vacuity guard the cold shell gets, and it is load-bearing
  // here: a cold open that loaded no bytes means the app's chunks were already
  // in the timeline (a preload, or a measurement taken after the fact), and
  // every app-open ceiling below would then pass on an empty measurement.
  expect(
    cold.summary.sameOriginEncodedBytes,
    "cold app open measured (>=floor encoded bytes)"
  ).toBeGreaterThanOrEqual(perfBudgets.appOpen.cold.minEncodedBytes);
  expect(
    cold.summary.sameOriginRequestCount,
    "cold app request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxRequests);
  // All-origin count, including the byte-blind cross-origin gateway calls the
  // same-origin byte fences cannot see.
  expect(
    cold.summary.requestCount,
    "cold app all-origin request count"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxTotalRequests);
  expect(
    cold.summary.sameOriginEncodedBytes,
    "cold app encoded bytes"
  ).toBeLessThanOrEqual(perfBudgets.appOpen.cold.maxEncodedBytes);
  // Wire bytes: on a warm shell the SW answers every chunk out of Cache
  // Storage, so this is 0 today. The ceiling is what catches an app open that
  // starts going back to the network for its own assets.
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
    // Binding Layer content can produce a real LCP where the old connect screen
    // did not. Prefer a live ceiling; fall back to the parked intended ceiling
    // until web.json is re-seeded with a measured status.
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

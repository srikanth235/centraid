#!/usr/bin/env node
// Measures the network waterfall of opening a blueprint app, repeatedly, in
// the REAL desktop shell — see apps/desktop/tests/e2e-live/README.md for the
// rig. Baseline/regression probe for issue #356: a depth-unaware JSX
// specifier rewrite makes nested app components resolve
// `<app>/components/jsx-runtime.js` and `<app>/components/react-core.min.js`
// instead of the correct root-level URLs (so the 313KB vendored React
// bundle gets fetched twice), and no static asset carries any
// Cache-Control/ETag header, so every re-open re-transfers the full ~876KB
// instead of hitting cache. This script installs `photos` and `docs`,
// opens each app three times in the same session (Home → tile → iframe →
// Home → tile → ...), and for every open captures
// `performance.getEntriesByType('resource')` (plus the navigation entry)
// from INSIDE the app iframe's own window — the iframe gets a fresh
// Performance timeline per document load, so no clearResourceTimings() is
// needed between opens.
//
// Run with: node apps/desktop/tests/e2e-live/probe-open-waterfall.mjs
//
// Env:
//   WATERFALL_OUT        - path to write the JSON report (default:
//                           ./waterfall-report.json relative to cwd)
//   WATERFALL_SHOTS_DIR   - dir to write per-open screenshots (default:
//                           apps/desktop/tests/e2e-live/out/waterfall)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPORT_PATH = process.env.WATERFALL_OUT
  ? path.resolve(process.cwd(), process.env.WATERFALL_OUT)
  : path.resolve(process.cwd(), 'waterfall-report.json');
const SHOTS_DIR = process.env.WATERFALL_SHOTS_DIR
  ? path.resolve(process.cwd(), process.env.WATERFALL_SHOTS_DIR)
  : path.join(__dirname, 'out', 'waterfall');

// Each app: the Discover card label, the installed app-id (Home tile /
// AppFrame data attribute), and a selector that only appears once the
// app's own JS has booted (not just once the static index.html painted) —
// so "screenshot shows content" and "perf entries are complete" line up.
const APPS = [
  { id: 'photos', label: 'Photos', bootedSelector: 'h1' },
  { id: 'docs', label: 'Docs', bootedSelector: '#empty' },
];

// Basenames the #356 fix targets: the vendored React runtime + the shared
// kit/design-system assets every blueprint app pulls in.
const DUP_WATCH_BASENAMES = [
  'react-core.min.js',
  'jsx-runtime.js',
  'kit.js',
  'kit.css',
  'elements.js',
  'tokens.css',
  'wall.css',
];
const REACT_BUNDLE_BASENAMES = ['react-core.min.js', 'jsx-runtime.js'];

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function basenameOf(urlStr) {
  try {
    const m = /[^/]+(?=\/*$)/.exec(new URL(urlStr).pathname);
    return m ? m[0] : urlStr;
  } catch {
    return urlStr;
  }
}

function pathnameOf(urlStr) {
  try {
    return new URL(urlStr).pathname;
  } catch {
    return urlStr;
  }
}

/** Pull resource + navigation timing entries out of the iframe's OWN window. */
async function collectPerf(frame) {
  return frame.evaluate(() => {
    const resources = performance.getEntriesByType('resource').map((e) => ({
      name: e.name,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      responseStatus: 'responseStatus' in e ? e.responseStatus : null,
      initiatorType: e.initiatorType,
      duration: e.duration,
    }));
    const navEntry = performance.getEntriesByType('navigation')[0] ?? null;
    const navigation = navEntry
      ? {
          name: navEntry.name,
          transferSize: navEntry.transferSize,
          encodedBodySize: navEntry.encodedBodySize,
          decodedBodySize: navEntry.decodedBodySize,
          responseStatus: 'responseStatus' in navEntry ? navEntry.responseStatus : null,
          duration: navEntry.duration,
        }
      : null;
    return { resources, navigation };
  });
}

/** Turn raw resource-entry rows into the per-open report shape. */
function summarizeOpen({ resources, navigation }) {
  const requestCount = resources.length;
  const totalTransferSize = resources.reduce((s, e) => s + (e.transferSize || 0), 0);
  const totalEncodedBodySize = resources.reduce((s, e) => s + (e.encodedBodySize || 0), 0);

  const reactBundleRows = resources
    .filter((e) => REACT_BUNDLE_BASENAMES.includes(basenameOf(e.name)))
    .map((e) => ({
      url: e.name,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      initiatorType: e.initiatorType,
    }));

  const duplicates = [];
  for (const bn of DUP_WATCH_BASENAMES) {
    const matches = resources.filter((e) => basenameOf(e.name) === bn);
    const distinctPaths = [...new Set(matches.map((e) => pathnameOf(e.name)))];
    if (distinctPaths.length > 1) {
      duplicates.push({
        basename: bn,
        distinctPaths,
        rows: matches.map((e) => ({
          url: e.name,
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
        })),
      });
    }
  }

  const cachedCount = resources.filter((e) => (e.transferSize || 0) < 500).length;

  return {
    requestCount,
    totalTransferSize,
    totalEncodedBodySize,
    grandTotalTransferSize: totalTransferSize + (navigation?.transferSize || 0),
    navigation,
    reactBundleRows,
    duplicates,
    cachedCount,
  };
}

async function installApp(page, app) {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: app.label }).first();
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.click();

  const dialog = page.getByRole('dialog', { name: new RegExp(`^Preview ${app.label}`) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();

  const tile = page.locator(`[data-app-id="${app.id}"]`);
  await tile.waitFor({ state: 'visible', timeout: 20_000 });
  console.log(`[waterfall] installed ${app.label}`);
}

/** Open the app from Home (tile must already be visible), wait for it to
 *  boot, screenshot it, and pull the perf timeline out of its iframe. */
async function openAndMeasure(page, app, openIndex) {
  const tile = page.locator(`[data-app-id="${app.id}"]`);
  await tile.waitFor({ state: 'visible', timeout: 20_000 });
  await tile.getByTestId('app-tile').click();

  const iframeHandle = await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 30_000,
  });
  const frame = await iframeHandle.contentFrame();
  assert(frame !== null, `iframe.contentFrame() returned null on ${app.id} open #${openIndex}`);

  // Belt-and-suspenders: bump the resource timing buffer past the default
  // 250 in case a very chatty app is close to overflowing it. Entries
  // already recorded before this call are unaffected and stay in the
  // buffer either way.
  await frame.evaluate(() => {
    if (typeof performance.setResourceTimingBufferSize === 'function') {
      performance.setResourceTimingBufferSize(500);
    }
  });

  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator(app.bootedSelector).first().waitFor({ state: 'visible', timeout: 20_000 });
  // `bootedSelector` is static markup in index.html, so it paints before the
  // JS bundle (react-core.min.js, jsx-runtime.js, the app's own .jsx) has
  // even finished fetching — waiting on it alone under-counts a cold first
  // load. Wait for the iframe's own network to go quiet, THEN add a fixed
  // settle delay for anything that fires just after (SSE handshake, etc).
  await frame.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);

  const shotPath = path.join(SHOTS_DIR, `${app.id}-open${openIndex}.png`);
  await page.screenshot({ path: shotPath });

  const perf = await collectPerf(frame);
  console.log(
    `[waterfall] ${app.id} open #${openIndex}: ${perf.resources.length} resource entries, screenshot -> ${shotPath}`,
  );

  return { shotPath, perf };
}

async function main() {
  await fs.mkdir(SHOTS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });

  const t0 = Date.now();
  // Fresh temp userDataDir (like iframe-probe.mjs) for a reproducible,
  // virgin dev vault — kept the SAME across all opens of both apps in this
  // run, since re-opens within one session are exactly what's measured.
  const { page, userDataDir, close } = await launchApp();
  console.log(
    `[waterfall] launched + Home ready in ${Date.now() - t0}ms (userData=${userDataDir})`,
  );

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.setViewportSize({ width: 1400, height: 900 });

  /** @type {Record<string, any[]>} */
  const report = { apps: {}, meta: { capturedAt: new Date().toISOString(), userDataDir } };

  try {
    for (const app of APPS) {
      report.apps[app.id] = [];
      await installApp(page, app);

      for (let openIndex = 1; openIndex <= 3; openIndex += 1) {
        const { shotPath, perf } = await openAndMeasure(page, app, openIndex);
        const summary = summarizeOpen(perf);
        report.apps[app.id].push({ open: openIndex, screenshot: shotPath, ...summary });

        // Navigate back to Home before the next open (skip after the last
        // open of the last app — nothing left to measure).
        await navTo(page, 'Home');
        await page.getByRole('heading', { name: 'What should we build?' }).waitFor({
          state: 'visible',
          timeout: 15_000,
        });
      }
    }

    report.consoleErrorCount = consoleErrors.length;
    if (consoleErrors.length) {
      report.consoleErrorsSample = consoleErrors.slice(0, 20);
    }

    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[waterfall] wrote report -> ${REPORT_PATH}`);

    // Human-readable summary to stdout.
    console.log('\n================ WATERFALL SUMMARY ================');
    for (const app of APPS) {
      for (const row of report.apps[app.id]) {
        const dupNote = row.duplicates.length
          ? row.duplicates.map((d) => `${d.basename}x${d.distinctPaths.length}`).join(', ')
          : 'none';
        console.log(
          `${app.id} open#${row.open}: requests=${row.requestCount} transferSize=${row.totalTransferSize}B ` +
            `encodedBodySize=${row.totalEncodedBodySize}B cached<500B=${row.cachedCount} duplicates=[${dupNote}]`,
        );
      }
    }
    console.log('=====================================================');
  } catch (err) {
    const failShot = path.join(SHOTS_DIR, 'FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[waterfall] FAIL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await close();
    // NOTE: intentionally NOT removing userDataDir — same convention as
    // iframe-probe.mjs would if it kept state; here we leave it in case a
    // human wants to poke at the vault post-run. It's a temp-dir mkdtemp()
    // result so it won't collide with anything.
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

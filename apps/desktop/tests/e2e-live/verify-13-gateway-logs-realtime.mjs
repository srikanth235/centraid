#!/usr/bin/env node
// Verify the realtime gateway Logs surface (sidebar Gateway → Logs tab):
//  - the Logs tab renders,
//  - the SSE stream goes Live and replays the gateway's boot lines,
//  - a fresh gateway-side log line (vault rename via the real HTTP plane)
//    lands in the UI live, with no navigation/refresh,
//  - the Errors filter + text search + Clear behave.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-13');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v13-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v13-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'open-gateway-logs',
      'The sidebar Gateway page shows a Logs tab and it opens',
      async () => {
        await page
          .getByRole('button', { name: /^Gateway/ })
          .first()
          .click();
        await page
          .getByRole('heading', { name: 'Gateway' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        // The page's own tab strip: Overview / Components / Logs / Alerts.
        const logsTab = page.getByRole('tab', { name: 'Logs', exact: true });
        await logsTab.waitFor({ state: 'visible', timeout: 10_000 });
        await logsTab.click();
        await shot('01-logs-tab-open');
      },
    );

    await step(
      'stream-live-with-boot-lines',
      'Stream reports Live and replays gateway boot lines',
      async () => {
        await page
          .getByText('Live', { exact: true })
          .waitFor({ state: 'visible', timeout: 20_000 });
        // Boot always mounts the dev vault → at least one buffered line replays.
        await page
          .locator('div[data-level]')
          .first()
          .waitFor({ state: 'visible', timeout: 20_000 });
        const count = await page.locator('div[data-level]').count();
        console.log(`[v13] replayed log lines visible: ${count}`);
        await shot('02-live-with-boot-lines');
        assert(count >= 1, 'expected at least one replayed gateway log line after boot');
      },
    );

    await step(
      'live-line-lands-without-refresh',
      'A fresh gateway log line streams in live',
      async () => {
        const before = await page.locator('div[data-level]').count();
        // Fire a REAL owner act over the wire (rename the vault to its current
        // name — a no-op state-wise, but the vault plane logs it) and watch the
        // line arrive over the already-open SSE stream.
        const status = await page.evaluate(async () => {
          const auth = await window.CentraidApi.getGatewayAuth();
          const headers = {
            'Content-Type': 'application/json',
            ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
            ...(auth.vaultId ? { 'x-centraid-vault': auth.vaultId } : {}),
          };
          const list = await fetch(`${auth.baseUrl}/centraid/_vault/vaults`, { headers });
          const { vaults } = await list.json();
          const v = auth.vaultId
            ? (vaults.find((x) => x.vaultId === auth.vaultId) ?? vaults[0])
            : vaults[0];
          const res = await fetch(
            `${auth.baseUrl}/centraid/_vault/vaults/${encodeURIComponent(v.vaultId)}`,
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ name: v.name }),
            },
          );
          return res.status;
        });
        console.log(`[v13] rename PATCH status: ${status}`);
        assert(status === 200, `vault rename PATCH failed (HTTP ${status})`);
        await page
          .getByText(/renamed vault/)
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        const after = await page.locator('div[data-level]').count();
        console.log(`[v13] lines before=${before} after=${after}`);
        await shot('03-live-line-landed');
        assert(after > before, 'log line count did not grow after the live gateway act');
      },
    );

    await step('filter-and-search', 'Errors filter and text search narrow the view', async () => {
      await page.getByRole('button', { name: 'Errors', exact: true }).click();
      await page.waitForTimeout(300);
      const errorRows = await page
        .locator('div[data-level="info"], div[data-level="warn"]')
        .count();
      assert(errorRows === 0, `non-error rows visible under the Errors filter (${errorRows})`);
      await shot('04-errors-filter');

      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.getByPlaceholder('Filter messages…').fill('renamed vault');
      await page.waitForTimeout(300);
      const rows = page.locator('div[data-level]');
      const n = await rows.count();
      assert(n >= 1, 'search for "renamed vault" matched nothing');
      for (let i = 0; i < n; i++) {
        const text = await rows.nth(i).textContent();
        assert(text.includes('renamed vault'), `search leaked a non-matching row: ${text}`);
      }
      await shot('05-search-filtered');
      await page.getByPlaceholder('Filter messages…').fill('');
    });

    await step('clear-resets-view', 'Clear empties the view; stream stays live', async () => {
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.waitForTimeout(200);
      const count = await page.locator('div[data-level]').count();
      assert(count === 0, `rows still visible after Clear (${count})`);
      await page
        .getByText('No log lines yet', { exact: false })
        .waitFor({ state: 'visible', timeout: 5_000 });
      await shot('06-cleared');
    });

    // ---- Report ----
    console.log('\n================ VERIFY-13 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(34)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-13 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v13-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v13] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

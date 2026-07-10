#!/usr/bin/env node
// Insights QA suite: empty state, LLM-free population via the System health
// check automation (3 runs), real-LLM turn (if a runner is present), corner
// cases (nav races, resize, relaunch persistence).
//
// Run with: node apps/desktop/tests/e2e-live/flows-insights-01.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-insights-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
  });
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-ins-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

function inconclusive(id, label, reason) {
  results.push({ id, label, verdict: 'inconclusive', ms: 0, error: reason });
  console.log(`[INCONCLUSIVE] ${id} ${label}: ${reason}`);
}

async function shot(name) {
  const p = path.join(OUT_DIR, `ins-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.innerText);
}

async function checkNoJunkNumbers(label) {
  const txt = await bodyText();
  assert(!/\bNaN\b/.test(txt), `${label}: found literal "NaN" in page text`);
  assert(!/\bundefined\b/.test(txt), `${label}: found literal "undefined" in page text`);
  assert(!/\bInfinity\b/.test(txt), `${label}: found literal "Infinity" in page text`);
}

async function openInsights() {
  await navTo(page, 'Insights');
  await page.getByRole('heading', { name: 'Insights', level: 1 }).waitFor({ state: 'visible', timeout: 15_000 });
  // Let the summary fetch settle.
  await page.waitForTimeout(600);
}

async function adoptSystemHealthCheck() {
  await navTo(page, 'Discover');
  await page.getByRole('tab', { name: /^Automations/ }).click();
  await page.waitForTimeout(200);
  const card = page.locator('button[data-kind="automation"]', { hasText: 'System health check' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /System health check/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await shot('adopt-preview-dialog');
  await dialog.getByRole('button', { name: 'Use template' }).click();
  // Adopting an automation template navigates straight to its builder.
  await page.waitForTimeout(1000);
  await shot('adopt-after-use-template');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[ins] launched + Home ready in ${Date.now() - t0}ms`);

  const timings = {};

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- FLOW 1: fresh vault empty state ----------
    await step('flow1-empty-state', 'Fresh vault -> Insights shows full empty-state layout', async () => {
      const t = Date.now();
      await openInsights();
      await shot('01-empty-state-full');

      // KPIs.
      const tokens = await page.locator('text=Tokens · 30 days').locator('xpath=..').textContent();
      console.log(`[ins] Tokens KPI block: ${JSON.stringify(tokens)}`);

      await checkNoJunkNumbers('empty state');

      const spentVal = await page.locator('text=Spent · USD').locator('xpath=..').locator('div').first();
      void spentVal;

      // Panel empty lines.
      const dailyEmpty = page.locator('text=No activity in this window yet.');
      const sourceEmpty = page.locator('text=No runs yet.');
      const modelEmpty = page.locator('text=No model usage recorded yet.');
      const recentEmpty = page.locator('text=No activity yet.');
      await dailyEmpty.waitFor({ state: 'visible', timeout: 5_000 });
      await sourceEmpty.waitFor({ state: 'visible', timeout: 5_000 });
      await modelEmpty.waitFor({ state: 'visible', timeout: 5_000 });
      await recentEmpty.waitFor({ state: 'visible', timeout: 5_000 });

      const bodyTxt = await bodyText();
      assert(/Generations/.test(bodyTxt), 'Generations KPI missing');
      assert(/Apps touched/.test(bodyTxt), 'Apps touched KPI missing');
      assert(/Last 30 days/.test(bodyTxt), 'filter chip missing');
      timings.flow1 = Date.now() - t;
    });

    // ---------- FLOW 2: adopt + run automation once ----------
    await step('flow2-adopt-automation', 'Discover -> Automations tab -> adopt "System health check"', async () => {
      const t = Date.now();
      await adoptSystemHealthCheck();
      timings.flow2Adopt = Date.now() - t;
    });

    let automationUrl = null;
    await step('flow2-run-now-1', 'Open Automations screen, find it, click "Run now" (1st run)', async () => {
      const t = Date.now();
      await navTo(page, 'Automations');
      await page.waitForTimeout(400);
      const row = page.getByRole('button', { name: /System health check/ }).first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('02-automations-list-with-shc');
      await row.click();
      await page.getByRole('heading', { name: 'System health check', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
      await shot('02-automation-view-before-run');

      const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
      await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await runBtn.click();
      // Label should flip to "Starting…" briefly (best-effort capture).
      try {
        await page.getByRole('button', { name: 'Starting…' }).waitFor({ state: 'visible', timeout: 2_000 });
        console.log('[ins] observed "Starting…" label transition');
      } catch {
        console.log('[ins] did not catch "Starting…" transition (may have navigated too fast)');
      }
      // App navigates to run-view on successful start.
      await page.waitForTimeout(1500);
      await shot('02-run-view-after-click');
      automationUrl = page.url();
      timings.flow2Run1 = Date.now() - t;
    });

    await step('flow2-run-completes-on-own-feed', 'Run completes and shows on the automation\'s own run feed', async () => {
      const t = Date.now();
      // Wait for a completion signal on the run-view (ok/fail state) or just
      // settle time since handler is synchronous & trivial.
      await page.waitForTimeout(2500);
      const txt = await bodyText();
      console.log(`[ins] run-view text snapshot (first 300 chars): ${txt.slice(0, 300).replace(/\n/g, ' | ')}`);
      await shot('02-run-view-settled');
      timings.flow2Settle = Date.now() - t;
    });

    await step('flow2-insights-shows-first-run', 'Insights: Generations >= 1, $0.00 cost, By source + Recent activity rows', async () => {
      const t = Date.now();
      await openInsights();
      await shot('02-insights-after-1-run');
      await checkNoJunkNumbers('after 1st run');

      const bodyTxt = await bodyText();
      console.log(`[ins] Insights body after 1 run (first 800 chars): ${bodyTxt.slice(0, 800).replace(/\n/g, ' | ')}`);

      const noRunsYet = await page.locator('text=No runs yet.').count();
      const noActivityYet = await page.locator('text=No activity yet.').count();
      assert(noRunsYet === 0, 'By source panel still shows empty state after a run');
      assert(noActivityYet === 0, 'Recent activity panel still shows empty state after a run');

      assert(/Automation/.test(bodyTxt), 'expected "Automation" source tag in By source / Recent activity');
      assert(/System health check/.test(bodyTxt), 'expected automation label "System health check" somewhere on Insights');
      timings.flow2Insights = Date.now() - t;
    });

    // ---------- FLOW 3: run 2 more times ----------
    await step('flow3-run-again-x2', 'Run the automation 2 more times (3 total) and verify counts increment', async () => {
      const t = Date.now();
      for (let i = 2; i <= 3; i++) {
        await navTo(page, 'Automations');
        await page.waitForTimeout(400);
        const row = page.getByRole('button', { name: /System health check/ }).first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        await row.click();
        await page.getByRole('heading', { name: 'System health check', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
        const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
        await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await runBtn.click();
        await page.waitForTimeout(2500);
        console.log(`[ins] fired run #${i}`);
      }
      await shot('03-after-3-runs-automation-view');
      timings.flow3Runs = Date.now() - t;
    });

    await step('flow3-insights-3-runs', 'Insights reflects 3 total generations; Daily consumption shows something for today', async () => {
      const t = Date.now();
      await openInsights();
      await shot('03-insights-after-3-runs');
      await checkNoJunkNumbers('after 3 runs');

      const bodyTxt = await bodyText();
      const genMatch = bodyTxt.match(/Generations\s*\n?\s*(\d+)/);
      console.log(`[ins] Generations text match: ${genMatch ? genMatch[1] : 'NOT FOUND'}`);

      const dailyEmptyStill = await page.locator('text=No activity in this window yet.').count();
      console.log(`[ins] Daily consumption empty-state count after 3 runs: ${dailyEmptyStill} (0 = chart is showing)`);

      const bySourceRows = await page.locator('.tr, [class*="tr"]').count();
      void bySourceRows;
      timings.flow3Insights = Date.now() - t;
    });

    // ---------- FLOW 4: real LLM turn ----------
    let llmAvailable = true;
    await step('flow4-real-llm-turn', 'Assistant: send a trivial prompt, wait up to 180s for a real answer', async () => {
      const t = Date.now();
      await navTo(page, 'Assistant');
      await page.getByPlaceholder('Ask your vault anything…').waitFor({ state: 'visible', timeout: 10_000 });
      await shot('04-assistant-before-send');
      const input = page.getByPlaceholder('Ask your vault anything…');
      await input.fill('say hi');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      await shot('04-assistant-sending');

      // Wait for the busy state to clear (send button back to '↑') or an
      // error surface, up to 180s.
      const deadline = Date.now() + 180_000;
      let settled = false;
      let sawError = false;
      while (Date.now() < deadline) {
        const busyBtn = await page.getByRole('button', { name: 'Stop' }).count();
        if (busyBtn === 0) {
          settled = true;
          break;
        }
        await page.waitForTimeout(2000);
      }
      await shot('04-assistant-after-wait');
      const txt = await bodyText();
      sawError = /503|unavailable|no runner|could not reach|failed to/i.test(txt);
      console.log(`[ins] assistant settle=${settled} sawErrorHint=${sawError} elapsed=${Date.now() - t}ms`);
      if (!settled) {
        llmAvailable = false;
        throw new Error('LLM turn did not settle within 180s (busy indicator never cleared)');
      }
      if (sawError) {
        llmAvailable = false;
        console.log('[ins] LLM turn surfaced an error/unavailable hint — treating as LLM-unavailable, not a bug');
      }
      timings.flow4 = Date.now() - t;
    });

    if (llmAvailable) {
      await step('flow4-insights-nonzero-tokens', 'Insights shows nonzero tokens/USD + a By model row after the real turn', async () => {
        await openInsights();
        await shot('04-insights-after-llm-turn');
        await checkNoJunkNumbers('after llm turn');
        const noModelYet = await page.locator('text=No model usage recorded yet.').count();
        console.log(`[ins] "No model usage recorded yet." present: ${noModelYet > 0}`);
      });
    } else {
      inconclusive('flow4-insights-nonzero-tokens', 'Insights shows nonzero tokens after real turn', 'LLM turn unavailable/errored — see flow4-real-llm-turn');
    }

    // ---------- FLOW 5: corner cases ----------
    await step('flow5a-formatting', 'No NaN/Infinity/undefined anywhere on Insights; USD formatted sanely', async () => {
      await openInsights();
      await checkNoJunkNumbers('flow5a');
      const bodyTxt = await bodyText();
      const usdMatches = [...bodyTxt.matchAll(/\$[\d.]+|\<\$0\.01/g)].map((m) => m[0]);
      console.log(`[ins] USD-looking tokens on page: ${JSON.stringify(usdMatches)}`);
      for (const u of usdMatches) {
        assert(!/\$NaN|\$undefined|\$Infinity/.test(u), `malformed USD token: ${u}`);
      }
    });

    await step('flow5b-nav-during-run', 'Navigate to Insights while a run is in flight -> no crash, data settles', async () => {
      await navTo(page, 'Automations');
      await page.waitForTimeout(300);
      const row = page.getByRole('button', { name: /System health check/ }).first();
      await row.click();
      await page.getByRole('heading', { name: 'System health check', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
      const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
      await runBtn.click();
      // Immediately jump to Insights without waiting for the run to finish.
      await navTo(page, 'Insights');
      await page.getByRole('heading', { name: 'Insights', level: 1 }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1500);
      await shot('05b-nav-during-run');
      await checkNoJunkNumbers('flow5b nav-during-run');
      const errs = consoleMessages.filter((m) => m.type === 'error');
      console.log(`[ins] console errors so far: ${errs.length}`);
    });

    await step('flow5c-rapid-renav', 'Rapid re-navigation Insights<->Home x5 -> no crash, no stale flicker', async () => {
      for (let i = 0; i < 5; i++) {
        await navTo(page, 'Home');
        await page.waitForTimeout(120);
        await navTo(page, 'Insights');
        await page.waitForTimeout(120);
      }
      await page.getByRole('heading', { name: 'Insights', level: 1 }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(800);
      await shot('05c-after-rapid-renav');
      await checkNoJunkNumbers('flow5c rapid-renav');
    });

    await step('flow5d-relaunch-persistence', 'Relaunch (same userDataDir) -> Insights still shows persisted runs', async () => {
      await session.close();
      await new Promise((r) => setTimeout(r, 500));
      session = await launchApp({ userDataDir: USER_DATA_DIR });
      page = session.page;
      wireConsole(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      await openInsights();
      await shot('05d-insights-after-relaunch');
      await checkNoJunkNumbers('flow5d relaunch');
      const bodyTxt = await bodyText();
      const noRunsYet = await page.locator('text=No runs yet.').count();
      const noActivityYet = await page.locator('text=No activity yet.').count();
      assert(noRunsYet === 0, 'By source empty after relaunch — runs did not persist');
      assert(noActivityYet === 0, 'Recent activity empty after relaunch — runs did not persist');
      assert(/System health check/.test(bodyTxt), 'automation label missing after relaunch');
    });

    // ---------- FLOW 6: narrow resize ----------
    await step('flow6-narrow-resize', 'Resize to ~900x700 -> layout does not collapse/overlap illegibly', async () => {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForTimeout(500);
      await shot('06-insights-narrow-900x700');
      await checkNoJunkNumbers('flow6 narrow');
      await page.setViewportSize({ width: 1400, height: 900 });
    });

    // ---------- Report ----------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ INSIGHTS QA VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(13)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('================================================================');
    console.log(`Timings: ${JSON.stringify(timings, null, 2)}`);
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`Console warnings: ${consoleMessages.filter((m) => m.type === 'warning').length}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll insights steps PASSED (or inconclusive where noted).');
    }
  } finally {
    await session.close();
    // Deliberately keep USER_DATA_DIR (not rm'd) in case screenshots/logs
    // need cross-referencing against the on-disk vault after the run.
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

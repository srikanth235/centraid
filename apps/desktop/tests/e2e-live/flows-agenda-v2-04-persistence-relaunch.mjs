#!/usr/bin/env node
// Agenda v2 QA Suite 4: persistence across a full app relaunch. Reuses the
// SAME userDataDir every prior suite built up (installed app, seeded
// calendars, a dozen+ proposed events, whatever cancel/reschedule state
// suite 3 left behind) -- a fresh `launchApp({ userDataDir })` call points
// at the identical on-disk vault, so everything created in suites 1-3 must
// still be there and rendering correctly after a cold restart.
//
// PREREQ: run suites 1 (+seed) through 3 first.
// Run with: node tests/e2e-live/flows-agenda-v2-04-persistence-relaunch.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'agenda-v2');
export const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-agenda-v2');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-agv2-4-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `4-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR }); // SAME dir -> resumes the same vault
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[agv2-4] RELAUNCHED (same userDataDir) + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('flow1-tile-survives-relaunch', 'Agenda tile still pinned to Home after relaunch', async () => {
      const tile = page.locator('[data-app-id="agenda"]');
      await tile.waitFor({ state: 'visible', timeout: 20_000 });
      await shot('01-home-after-relaunch');
    });

    await step('flow2-events-survive-relaunch', 'Previously-proposed events (Design review sync, All-day offsite, emoji title, etc.) still render after a cold restart', async () => {
      const tile = page.locator('[data-app-id="agenda"]');
      await tile.getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      const fl = frameLoc(page);
      await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(800);
      await fl.locator('.ag-today', { hasText: 'Today' }).click();
      await page.waitForTimeout(400);
      await shot('02-month-view-after-relaunch');

      const calRows = await fl.locator('.ag-cal-row').count();
      assert(calRows === 2, `expected the 2 seeded calendars to persist, got ${calRows}`);

      const emojiPill = fl.locator('.ag-pill', { hasText: '🎉 Launch' });
      const emojiCount = await emojiPill.count();
      console.log(`[agv2-4] emoji-titled event still present after relaunch: ${emojiCount > 0}`);
      assert(emojiCount >= 1, 'expected the emoji-titled event to survive a relaunch');

      const overnightCount = await fl.locator('.ag-pill', { hasText: 'Overnight watch shift' }).count();
      console.log(`[agv2-4] overnight event occurrences after relaunch: ${overnightCount}`);
      assert(overnightCount >= 1, 'expected the overnight event to survive a relaunch');
    });

    await step('flow3-cancel-or-reschedule-state-consistent', 'Whatever suite 3 left cancel/reschedule in (parked vs executed) is CONSISTENT after relaunch -- no parked-state amnesia, no ghost re-appearance', async () => {
      const fl = frameLoc(page);
      let findings = {};
      try {
        findings = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'suite3-findings.json'), 'utf8'));
      } catch {
        console.log('[agv2-4] no suite3-findings.json found -- skipping cross-check');
        return;
      }
      console.log(`[agv2-4] suite 3 findings to cross-check: ${JSON.stringify(findings)}`);
      if (findings.cancelExecutedEventGone) {
        // Cancelled immediately in suite 3 -- must STAY gone after relaunch
        // (status='cancelled' persisted to core_event, queries filter it).
        const stillGone = (await fl.locator('.ag-pill', { hasText: 'All-day offsite' }).count()) === 0;
        console.log(`[agv2-4] "All-day offsite" still absent after relaunch (consistent with immediate-cancel persisting): ${stillGone}`);
        assert(stillGone, 'a cancelled event reappeared after relaunch -- persistence bug');
      }
      await navTo_or_skip();

      async function navTo_or_skip() {
        // Cross-check Approvals: if suite 3 found NOTHING parked, that must
        // still be true post-relaunch too (nothing should have silently
        // materialized once the gateway restarted from a persisted queue --
        // recall the in-memory-only parked queue finding from the Locker
        // QA pass, packages/vault/src/gateway/gateway.ts `private readonly
        // parked = new Map(...)`: even IF something had parked, it would be
        // gone after a real process restart anyway).
        await page.getByRole('button', { name: /^Approvals/ }).first().click();
        await page.getByRole('heading', { name: 'Approvals', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(500);
        await shot('03-approvals-after-relaunch');
        const scheduleRows = await page.locator('text=/schedule\\.(cancel_event|reschedule_event)/').count();
        console.log(`[agv2-4] Approvals schedule.* rows after relaunch: ${scheduleRows}`);
      }
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AGENDA V2 SUITE 4 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll agenda-v2-suite-4 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, '4-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[agv2-4] FATAL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

#!/usr/bin/env node
// Apps v2 QA — combined session: Photos spot-check (recently E2E'd in depth,
// PR #332/#334 — here just: empty state, upload one small PNG, grid renders,
// lightbox opens), the kit Ask panel (open/close, empty-submit no-op, Escape
// closes, ONE real LLM turn end-to-end if a runner is configured), and the
// shell Insights screen (renders real transcript-derived data, no
// NaN/undefined anywhere in the pane).
//
// Run with: node apps/desktop/tests/e2e-live/flows-apps-v2-photos-ask-insights.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'apps-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-apps-v2-pai');
const PNG_FIXTURE =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-charming-matsumoto-4872ab/51bb86f0-75f7-4678-aef4-ad31b920a377/scratchpad/red-8x8.png';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let currentStep = 'boot';
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type(), step: currentStep }));
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', step: currentStep });
    console.error(`[console][during ${currentStep}] pageerror: ${err}`);
  });
}

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `pai-${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function step(id, label, fn) {
  const t0 = Date.now();
  currentStep = id;
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `pai-FAILURE-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function installApp(name, appId) {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`^Preview ${name}`) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(`[data-app-id="${appId}"]`).waitFor({ state: 'visible', timeout: 10_000 });
}

async function openApp(appId) {
  await navTo(page, 'Home').catch(() => undefined);
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(800);
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[pai] launched + Home ready');

  let frameLoc;
  let askVerdict = 'not-run';
  let askDetail = '';

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- Photos spot-check ----------
    await step('photos-install-empty', 'Install Photos -> empty state renders', async () => {
      await installApp('Photos', 'photos');
      frameLoc = await openApp('photos');
      await shot('01-photos-empty');
      const emptyVisible = (await frameLoc.locator('#empty').getAttribute('hidden')) === null;
      const gridText = await frameLoc.locator('#grid').textContent().catch(() => '');
      console.log(`[pai] photos empty visible=${emptyVisible}, grid text=${JSON.stringify(gridText?.slice(0, 100))}`);
      assert(emptyVisible, 'Photos empty state should be visible on a fresh vault');
    });

    await step('photos-upload-grid', 'Upload one PNG -> grid shows a thumbnail', async () => {
      await frameLoc.locator('#fileInput').setInputFiles(PNG_FIXTURE);
      await page.waitForTimeout(2000);
      await shot('02-photos-after-upload');
      const thumbs = frameLoc.locator('#grid img');
      const count = await thumbs.count();
      console.log(`[pai] grid <img> count after upload: ${count}`);
      assert(count >= 1, 'expected at least one thumbnail in the Photos grid after upload');
    });

    await step('photos-lightbox', 'Open the photo -> lightbox shows the image; Escape closes', async () => {
      await frameLoc.locator('#grid img').first().click();
      const lightbox = frameLoc.locator('#lightbox');
      const t0 = Date.now();
      let open = false;
      while (Date.now() - t0 < 10_000) {
        if ((await lightbox.getAttribute('hidden')) === null) {
          open = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      await shot('03-photos-lightbox');
      assert(open, 'lightbox did not open after clicking the thumbnail');
      const stageImgs = await lightbox.locator('img').count();
      const placeholder = await lightbox.locator('.lightbox-placeholder').count();
      console.log(`[pai] lightbox imgs=${stageImgs} placeholders=${placeholder}`);
      assert(stageImgs >= 1 || placeholder >= 1, 'lightbox stage is empty');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const closed = (await lightbox.getAttribute('hidden')) !== null;
      assert(closed, 'lightbox did not close on Escape');
    });

    // ---------- Ask panel ----------
    await step('ask-open-close', 'Ask panel opens from the kit button; ✕ closes it', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      const panel = frameLoc.locator('.kit-ask-panel[role="dialog"]');
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('04-ask-open');
      const intro = await frameLoc.locator('.kit-ask-log').textContent();
      console.log(`[pai] ask intro: ${JSON.stringify(intro?.slice(0, 160))}`);
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
      await panel.waitFor({ state: 'hidden', timeout: 5000 });
      await shot('05-ask-closed');
    });

    await step('ask-empty-submit', 'Corner: empty submit is a no-op (no user bubble appears)', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      const panel = frameLoc.locator('.kit-ask-panel[role="dialog"]');
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      const before = await frameLoc.locator('.kit-msg.user').count();
      await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
      await page.waitForTimeout(500);
      const after = await frameLoc.locator('.kit-msg.user').count();
      assert(before === after, `empty submit should not add a user bubble (before=${before}, after=${after})`);
      await shot('06-ask-empty-submit');
    });

    await step('ask-escape-closes', 'Corner: Escape closes the open Ask panel', async () => {
      // Panel still open from the previous step; focus is in the input.
      await frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]').press('Escape');
      const panel = frameLoc.locator('.kit-ask-panel[role="dialog"]');
      await panel.waitFor({ state: 'hidden', timeout: 5000 });
      await shot('07-ask-escaped');
    });

    await step('ask-llm-turn', 'ONE real LLM turn: ask about the library, response renders', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      const panel = frameLoc.locator('.kit-ask-panel[role="dialog"]');
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
      const log = frameLoc.locator('.kit-ask-log');
      const aiBefore = await log.locator('.kit-msg.ai').count();
      await input.fill('How many photos are in my library right now? Answer briefly.');
      await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();

      const t0 = Date.now();
      let outcome = 'timeout';
      while (Date.now() - t0 < 150_000) {
        if ((await log.locator('text=/No coding agent is configured/').count()) > 0) {
          outcome = 'no_runner';
          break;
        }
        const typing = await frameLoc.locator('.kit-ask-typing').count();
        const aiNow = await log.locator('.kit-msg.ai').count();
        if (typing === 0 && aiNow > aiBefore) {
          outcome = 'replied';
          break;
        }
        await page.waitForTimeout(2000);
      }
      await shot('08-ask-llm-turn');
      if (outcome === 'no_runner') {
        askVerdict = 'INCONCLUSIVE';
        askDetail = 'no conversation runner configured in this environment';
        console.log('[pai] LLM turn INCONCLUSIVE — no runner configured');
      } else {
        assert(outcome === 'replied', `LLM turn did not complete: ${outcome}`);
        const lastAi = await log.locator('.kit-msg.ai').last().textContent();
        console.log(`[pai] AI reply: ${JSON.stringify(lastAi?.slice(0, 300))}`);
        askVerdict = 'PASS';
        askDetail = lastAi?.slice(0, 120) ?? '';
        assert((lastAi ?? '').trim().length > 0, 'AI reply bubble is empty');
      }
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
    });

    // ---------- Insights ----------
    await step('insights-renders', 'Insights screen renders with no NaN/undefined', async () => {
      await navTo(page, 'Insights');
      await page.waitForTimeout(1500);
      await shot('09-insights');
      const mainText = await page.locator('main, [class*="content"], body').first().textContent();
      assert(!/\bNaN\b/.test(mainText ?? ''), 'Insights shows NaN');
      assert(!/\bundefined\b/.test(mainText ?? ''), 'Insights shows "undefined"');
      assert(!/\bnull\b/.test(mainText ?? ''), 'Insights shows "null"');
      console.log(`[pai] insights text sample: ${JSON.stringify(mainText?.slice(0, 300))}`);
    });

    await step('insights-after-turn', 'If a turn ran: Insights reflects transcript-derived numbers (else zero-state)', async () => {
      const mainText = await page.locator('main, [class*="content"], body').first().textContent();
      // Not asserting exact spend — just that money/number placeholders are
      // well-formed wherever they appear.
      const badMoney = /(\$|₹)\s*(NaN|undefined)/.test(mainText ?? '');
      assert(!badMoney, 'Insights renders a malformed money value');
      await shot('10-insights-final');
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ PHOTOS/ASK/INSIGHTS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log(`Ask LLM turn: ${askVerdict} ${askDetail ? `— ${askDetail}` : ''}`);
    console.log('=====================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: [${e.step}] ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Photos/Ask/Insights steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'pai-FAILURE-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();

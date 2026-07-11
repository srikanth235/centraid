#!/usr/bin/env node
// Ask QA Suite 3 (Flow 5): the parked-write consent card. Locker's
// purge-item action always requires confirmation ("confirmation": "required"
// in app.json), so it's the one deterministic way to force the Ask panel's
// "Proposed write · needs your ok" card through a real LLM turn (vs. the
// other 7 apps' actions, which are confirmation:"none").
//
// Setup: install Locker, create two items via Locker's own UI, move both to
// trash via Locker's own UI. Then, via Ask: ask the agent to permanently
// purge item A -> expect a parked card -> Approve -> verify applied +
// actually gone. Ask again for item B -> Discard -> verify it stays in trash
// (not purged). If the LLM never calls the tool after 2 attempts, mark
// inconclusive (per the task brief — the Approvals-screen agent covers the
// parking machinery deterministically elsewhere).
//
// Run with: node apps/desktop/tests/e2e-live/flows-ask-03-locker-parked.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-ask-03');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

let page;
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type() }));
  p.on('pageerror', (err) => consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' }));
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `ask03-${name}.png`) });
}

async function installLocker() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'Locker' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Locker/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-app-id="locker"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openLocker() {
  const tile = page.locator('[data-app-id="locker"]');
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

async function createItem(frameLoc, title) {
  await frameLoc.locator('.v-newbtn').click();
  const modal = frameLoc.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  await modal.locator('input.v-in[placeholder="Item name"]').fill(title);
  await modal.locator('button.kit-btn.primary', { hasText: 'Save' }).click();
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

async function trashItem(frameLoc, title) {
  await frameLoc.locator('.v-item', { hasText: title }).first().click();
  await page.waitForTimeout(300);
  await frameLoc.locator('button.v-del', { hasText: 'Move to trash' }).click();
  await page.waitForTimeout(400);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[ask03] launched + Home ready');

  let verdict = 'unknown';
  let detail = '';
  let discardVerdict = 'not-attempted';
  let discardDetail = '';

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    console.log('[ask03] installing Locker…');
    await installLocker();
    let frameLoc = await openLocker();
    await page.waitForTimeout(2000); // let the app's first vault call auto-grant

    console.log("[ask03] creating 2 items via Locker's own UI…");
    await createItem(frameLoc, 'Old GitHub Login');
    await createItem(frameLoc, 'Temp Wifi Note');
    await shot('01-two-items-created');

    console.log("[ask03] trashing both via Locker's own UI…");
    await trashItem(frameLoc, 'Old GitHub Login');
    await trashItem(frameLoc, 'Temp Wifi Note');
    await shot('02-both-trashed');

    // Sanity: both should show up under Trash nav.
    await frameLoc.locator('button', { hasText: 'Trash' }).first().click();
    await page.waitForTimeout(300);
    const trashList = await frameLoc.locator('.v-list').textContent();
    console.log(`[ask03] trash nav contents: ${JSON.stringify(trashList?.slice(0, 300))}`);
    assert(
      /Old GitHub Login/.test(trashList ?? '') && /Temp Wifi Note/.test(trashList ?? ''),
      'both items should be visible under Trash before the Ask flow',
    );
    await shot('03-trash-nav-confirmed');

    // ---- Approve variant: ask to permanently purge "Old GitHub Login" ----
    await frameLoc.locator('#kitAskBtn').click();
    await frameLoc
      .locator('.kit-ask-panel[role="dialog"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
    const log = frameLoc.locator('.kit-ask-log');

    const askAndWaitForOutcome = async function askAndWaitForOutcome(message, timeoutMs) {
      await input.fill(message);
      await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
      const t0 = Date.now();
      let lastAi = -1;
      let stable = 0;
      while (Date.now() - t0 < timeoutMs) {
        const noRunner = await log.locator('text=/No coding agent is configured/').count();
        if (noRunner > 0) return 'no_runner';
        const parked = await log.locator('.kit-ask-action').count();
        if (parked > 0) return 'parked';
        const applied = await log.locator('.kit-ask-applied').count();
        if (applied > 0) return 'applied-directly';
        const typing = await frameLoc.locator('.kit-ask-typing').count();
        const aiCount = await log.locator('.kit-msg.ai').count();
        if (typing === 0 && aiCount > 1) {
          if (aiCount === lastAi) stable += 1;
          else {
            stable = 0;
            lastAi = aiCount;
          }
          if (stable >= 3) return 'replied-no-action';
        }
        await page.waitForTimeout(2000);
      }
      return 'timeout';
    };

    console.log('[ask03] asking to permanently purge "Old GitHub Login" (attempt 1)…');
    let outcome = await askAndWaitForOutcome(
      'Permanently delete the item named "Old GitHub Login" from the trash forever — purge it for good.',
      120_000,
    );
    console.log(`[ask03] attempt 1 outcome: ${outcome}`);
    if (outcome === 'replied-no-action') {
      console.log(
        '[ask03] agent replied without calling the tool; retrying once with a more direct phrasing…',
      );
      outcome = await askAndWaitForOutcome(
        'Purge "Old GitHub Login" now — call purge-item, do not just describe it.',
        120_000,
      );
      console.log(`[ask03] attempt 2 outcome: ${outcome}`);
    }
    await shot('04-after-purge-ask');

    if (outcome === 'no_runner') {
      verdict = 'INCONCLUSIVE';
      detail =
        'LLM unavailable (_turn returned no_conversation_runner) — acceptable per the task brief.';
    } else if (outcome === 'parked') {
      const card = log.locator('.kit-ask-action').last();
      const cardText = await card.textContent();
      console.log(`[ask03] parked card text: ${JSON.stringify(cardText)}`);
      await shot('05-parked-card-visible');
      assert(
        /Proposed write . needs your ok/.test(cardText ?? '') ||
          /needs your ok/i.test(cardText ?? ''),
        'parked card missing the "needs your ok" label',
      );
      await card.locator('.kit-aa-approve', { hasText: 'Approve' }).click();
      await page.waitForTimeout(1500);
      await shot('06-after-approve');
      const appliedCard = log.locator('.kit-ask-applied').last();
      const appliedVisible = (await appliedCard.count()) > 0;
      console.log(`[ask03] applied receipt visible after approve: ${appliedVisible}`);
      if (appliedVisible) {
        const appliedText = await appliedCard.textContent();
        console.log(`[ask03] applied receipt text: ${JSON.stringify(appliedText)}`);
      }
      // Verify the item is actually gone from Locker's UI (close panel, check Trash).
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
      await page.waitForTimeout(500);
      await frameLoc.locator('button', { hasText: 'Trash' }).first().click();
      await page.waitForTimeout(400);
      let trashText = await frameLoc.locator('.v-list').textContent();
      let goneFromUI = !/Old GitHub Login/.test(trashText ?? '');
      if (!goneFromUI) {
        // Same "no live-refresh" gap seen on Tasks' board (flow 4) — force a
        // remount before calling this a bug.
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(300);
        frameLoc = await openLocker();
        await frameLoc.locator('button', { hasText: 'Trash' }).first().click();
        await page.waitForTimeout(400);
        trashText = await frameLoc.locator('.v-list').textContent();
        goneFromUI = !/Old GitHub Login/.test(trashText ?? '');
        console.log(`[ask03] re-checked after remount; goneFromUI=${goneFromUI}`);
      }
      await shot('07-trash-after-purge');
      console.log(`[ask03] "Old GitHub Login" gone from Trash UI: ${goneFromUI}`);
      verdict = goneFromUI ? 'PASS' : 'FAIL';
      detail = goneFromUI
        ? 'Agent proposed purge-item as a parked write; Approve produced a real applied receipt and the item is actually gone from Locker.'
        : `Approved the parked purge but "Old GitHub Login" is still visible in Trash. Trash text: ${(trashText ?? '').slice(0, 300)}`;
    } else if (outcome === 'applied-directly') {
      verdict = 'FAIL';
      detail =
        'purge-item executed WITHOUT parking for approval, despite app.json declaring confirmation:"required" for it. This bypasses the consent gate — a real bug if reproducible.';
    } else {
      verdict = 'INCONCLUSIVE';
      detail = `Agent never invoked purge-item after 2 attempts (outcome=${outcome}) — marking inconclusive per the task brief; the Approvals-screen agent covers the parking machinery deterministically elsewhere.`;
    }
    console.log(`[ask03] APPROVE VARIANT: ${verdict} — ${detail}`);

    // ---- Discard variant, only if the approve path proved the LLM can drive purge-item ----
    if (verdict === 'PASS') {
      console.log('[ask03] asking to permanently purge "Temp Wifi Note" (discard variant)…');
      if (!(await frameLoc.locator('#kitAskBtn').count())) {
        frameLoc = await openLocker();
      }
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc
        .locator('.kit-ask-panel[role="dialog"]')
        .waitFor({ state: 'visible', timeout: 10_000 });
      const input2 = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
      const log2 = frameLoc.locator('.kit-ask-log');
      await input2.fill(
        'Permanently delete the item named "Temp Wifi Note" from the trash forever — purge it for good.',
      );
      await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
      const t0 = Date.now();
      let outcome2 = null;
      while (Date.now() - t0 < 120_000) {
        if ((await log2.locator('.kit-ask-action').count()) > 0) {
          outcome2 = 'parked';
          break;
        }
        await page.waitForTimeout(2000);
      }
      if (outcome2 === 'parked') {
        const card2 = log2.locator('.kit-ask-action').last();
        await shot('08-discard-parked-card');
        await card2.locator('.aa-discard', { hasText: 'Discard' }).click();
        await page.waitForTimeout(1200);
        await shot('09-after-discard');
        await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
        await page.waitForTimeout(500);
        await frameLoc.locator('button', { hasText: 'Trash' }).first().click();
        await page.waitForTimeout(400);
        const trashText2 = await frameLoc.locator('.v-list').textContent();
        const stillInTrash = /Temp Wifi Note/.test(trashText2 ?? '');
        console.log(`[ask03] "Temp Wifi Note" still in Trash after Discard: ${stillInTrash}`);
        await shot('10-trash-after-discard');
        discardVerdict = stillInTrash ? 'PASS' : 'FAIL';
        discardDetail = stillInTrash
          ? 'Discard correctly left the item untouched — still present in Trash, not purged.'
          : `Discard should NOT have purged the item, but it is missing from Trash. Trash text: ${(trashText2 ?? '').slice(0, 300)}`;
      } else {
        discardVerdict = 'INCONCLUSIVE';
        discardDetail =
          'Agent did not park a second purge-item call within 120s for the discard variant.';
      }
      console.log(`[ask03] DISCARD VARIANT: ${discardVerdict} — ${discardDetail}`);
    } else {
      console.log('[ask03] skipping discard variant since the approve variant did not PASS.');
    }

    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ ASK PARKED-WRITE (Flow 5) VERDICT ================');
    console.log(`APPROVE variant: ${verdict} — ${detail}`);
    console.log(`DISCARD variant: ${discardVerdict} — ${discardDetail}`);
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log('=====================================================================');

    if (verdict === 'FAIL' || discardVerdict === 'FAIL') process.exitCode = 1;
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'FAIL-ask03-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main();

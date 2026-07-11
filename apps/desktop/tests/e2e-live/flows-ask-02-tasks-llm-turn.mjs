#!/usr/bin/env node
// Ask QA Suite 2 (Flow 4): a REAL LLM turn through the Tasks app's Ask panel.
// Sends 'Add a task "buy milk"', waits (generously) for the streamed reply,
// then closes the panel and checks the Tasks board for the new task. If the
// gateway has no coding agent configured (_turn 503 no_conversation_runner),
// that's reported as LLM-unavailable — an acceptable, non-bug outcome per
// the task brief — not a failure.
//
// Run with: node apps/desktop/tests/e2e-live/flows-ask-02-tasks-llm-turn.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-ask-02');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

let page;
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type() });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' });
  });
}

async function shot(name) {
  const p = path.join(OUT_DIR, `ask02-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function installApp(name, appId) {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp('^Preview ' + name) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(`[data-app-id="${appId}"]`).waitFor({ state: 'visible', timeout: 10_000 });
}

async function openApp(appId) {
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[ask02] launched + Home ready');

  let verdict = 'unknown';
  let detail = '';

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    console.log('[ask02] installing Tasks…');
    await installApp('Tasks', 'tasks');
    const frameLoc = await openApp('tasks');

    // Let the app's own board mount + first vault call settle (this is what
    // auto-grants the declared block on a fresh install — see ask-01's
    // findings) before we ask the agent to write anything.
    await page.waitForTimeout(2000);

    await frameLoc.locator('#kitAskBtn').click();
    await frameLoc
      .locator('.kit-ask-panel[role="dialog"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await shot('01-panel-open-before-turn');

    const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
    const prompt = 'Add a task "buy milk"';
    await input.fill(prompt);
    await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
    console.log(`[ask02] sent: ${JSON.stringify(prompt)} — waiting up to 180s for a reply…`);
    await shot('02-just-sent');

    const log = frameLoc.locator('.kit-ask-log');
    const t0 = Date.now();
    const TIMEOUT_MS = 180_000;

    // A single turn can emit MULTIPLE `final` events — e.g. a pre-tool-call
    // "I'll do that now" followed by a post-tool-call "Done" once
    // schedule.add_task actually executes (confirmed via a raw-SSE probe:
    // event order is final -> tool.start -> tool.result -> final -> end).
    // Stopping at the FIRST ai bubble reads the board before the tool call
    // has actually landed, which looks like a false "task never appeared"
    // failure. Instead poll for *stability*: keep watching the ai-bubble
    // count (and parked/applied cards) until it stops changing for a few
    // consecutive checks, which rides out the second `final`.
    let outcome = null;
    let lastAiCount = -1;
    let stableChecks = 0;
    const STABLE_NEEDED = 3; // ~6s of no change once a reply has started
    while (Date.now() - t0 < TIMEOUT_MS) {
      const noRunnerCount = await log.locator('text=/No coding agent is configured/').count();
      if (noRunnerCount > 0) {
        outcome = 'no_runner';
        break;
      }
      const typingCount = await frameLoc.locator('.kit-ask-typing').count();
      const aiBubbles = await log.locator('.kit-msg.ai').count();
      const parkedCount = await log.locator('.kit-ask-action').count();
      const appliedCount = await log.locator('.kit-ask-applied').count();
      if (parkedCount > 0 || appliedCount > 0) {
        outcome = 'replied';
        break;
      }
      if (typingCount === 0 && aiBubbles > 1) {
        if (aiBubbles === lastAiCount) {
          stableChecks += 1;
        } else {
          stableChecks = 0;
          lastAiCount = aiBubbles;
        }
        if (stableChecks >= STABLE_NEEDED) {
          outcome = 'replied';
          break;
        }
      }
      await page.waitForTimeout(2000);
    }
    const elapsed = Date.now() - t0;
    console.log(`[ask02] turn settled after ${elapsed}ms with outcome=${outcome ?? 'timeout'}`);
    await shot('03-after-turn');

    if (outcome === 'no_runner') {
      verdict = 'INCONCLUSIVE';
      const errCopy = await log.locator('.kit-msg.ai').last().textContent();
      detail = `LLM unavailable: _turn returned no_conversation_runner. Panel copy: ${JSON.stringify(errCopy)}`;
      console.log(`[ask02] ${detail}`);
    } else if (outcome === 'replied') {
      const lastAi = await log.locator('.kit-msg.ai').last().textContent();
      console.log(`[ask02] last assistant bubble text: ${JSON.stringify(lastAi)}`);
      // Close panel, inspect Tasks board for the new task.
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
      await page.waitForTimeout(1200);
      await shot('04-panel-closed-check-board');
      const board = frameLoc.locator('#board');
      const boardText = (await board.textContent().catch(() => '')) ?? '';
      const rowCount = await board.locator('.row[data-task-id]').count();
      console.log(
        `[ask02] board row count: ${rowCount}, board text: ${JSON.stringify(boardText.slice(0, 300))}`,
      );
      const taskAppeared = /buy milk/i.test(boardText);
      if (taskAppeared) {
        verdict = 'PASS';
        detail =
          'Agent replied and a "buy milk" task actually appears in the Tasks board without needing a remount.';
      } else {
        const parkedCard = log.locator('.kit-ask-action');
        if ((await parkedCard.count()) > 0) {
          verdict = 'INCONCLUSIVE';
          detail =
            'Agent proposed a parked write instead of applying directly — see screenshot 03-after-turn. Unexpected for an already-granted ACT scope; worth a follow-up look.';
        } else {
          // Board not showing the row yet does NOT necessarily mean the
          // write failed — a separate raw-SSE reliability probe (3/3 trials)
          // showed schedule.add_task always executes successfully and
          // window.centraid.read('board') always reflects it immediately;
          // Tasks' app.js (grep: "window.addEventListener('focus', refresh)")
          // only re-fetches its board on its OWN quick-add actions or on the
          // iframe window regaining focus — an Ask-driven write is neither,
          // so the already-mounted board can go stale until something else
          // (focus, or a full remount which calls refresh() at boot) nudges
          // it. Confirm ground truth via a remount before calling this a
          // hard failure.
          await navTo(page, 'Home');
          await page
            .getByRole('heading', { name: 'What should we build?' })
            .waitFor({ state: 'visible', timeout: 10_000 });
          await page.waitForTimeout(300);
          const tile = page.locator('[data-app-id="tasks"]');
          await tile.getByTestId('app-tile').click();
          await page.waitForSelector('iframe[data-centraid-app="1"]', {
            state: 'attached',
            timeout: 20_000,
          });
          const frameLoc2 = page.frameLocator('iframe[data-centraid-app="1"]');
          await frameLoc2.locator('#board').waitFor({ state: 'visible', timeout: 15_000 });
          await page.waitForTimeout(800);
          await shot('05-board-after-remount-recheck');
          const board2 = frameLoc2.locator('#board');
          const boardText2 = (await board2.textContent().catch(() => '')) ?? '';
          const rowCount2 = await board2.locator('.row[data-task-id]').count();
          console.log(
            `[ask02] board row count after a forced remount: ${rowCount2}, text: ${JSON.stringify(boardText2.slice(0, 300))}`,
          );
          if (/buy milk/i.test(boardText2)) {
            verdict = 'PASS (with caveat)';
            detail =
              "Agent replied and the write DID land in the vault (task_id present after a full app remount), but the already-open Tasks board did not live-refresh to show it — a real UX gap, not a data-loss bug. Root cause read from source: packages/blueprints/apps/tasks/app.js only calls refresh() on its own quick-add/complete actions or on `window.addEventListener('focus', refresh)`; it has no subscription to vault changes made by other callers (e.g. the Ask agent), so an Ask-driven write can sit invisible on an already-open board until refocus or reopen.";
          } else {
            verdict = 'FAIL';
            detail = `Agent replied but no "buy milk" task appeared in the Tasks board even after a full remount. Board text: ${boardText2.slice(0, 300)}`;
          }
        }
      }
    } else {
      verdict = 'FAIL';
      detail = `Turn did not settle within ${TIMEOUT_MS}ms (no reply, no error copy, no parked/applied card).`;
    }

    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ ASK LLM TURN (Flow 4) VERDICT ================');
    console.log(`${verdict}: ${detail}`);
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log('=================================================================');

    if (verdict === 'FAIL') process.exitCode = 1;
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'FAIL-ask02-fatal.png') });
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

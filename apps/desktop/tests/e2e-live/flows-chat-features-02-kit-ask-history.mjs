#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#408) one stateful Electron flow covering in-app Ask history; splitting would duplicate the shared live gateway/session fixture and weaken the ordered assertions
// Chat features QA (2026-07-12): in-app kit Ask history + attachments,
// against the REAL Electron+gateway rig, driving the Tasks app iframe.
//   Flow 1: History button toggles the in-panel history view
//   Flow 2: send a message, reopen -> history list shows the conversation
//   Flow 3: attach a file in the Ask compose row, send, chip in bubble
//   Flow 4: busy contract — data-busy true while a turn is in flight, send
//           button disabled, false once the terminal SSE event lands
//   Flow 5: inline model picker (.kit-ask-model-btn) — open/select/persist
//           across a panel reopen (proves the PUT + re-fetch-on-open work)
//   Flow 6: magic-token text attachment reaches the real model (multimodal fix)
//   Flow 7: "+ New conversation" clears the active thread
//   Flow 8: reopen a past conversation from history -> transcript reloads
//
// Run with: node apps/desktop/tests/e2e-live/flows-chat-features-02-kit-ask-history.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-chat-02');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type() }));
  p.on('pageerror', (err) => consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' }));
}

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-chat02-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `chat02-${name}.png`) });
}

/** Real LLM turns observed at ~9-30s end to end. `.kit-ask-compose` now
 *  carries a `data-busy` contract (2026-07-12): 'true' from submit until the
 *  turn's terminal SSE event (final/error/aborted) or stream close, 'false'
 *  otherwise — spans the WHOLE turn including tool calls, not just the
 *  pre-first-token gap that the old `.kit-ask-typing` indicator covered (its
 *  `typing.done()` fired on the very FIRST `assistant.delta`, which is why
 *  this flow previously used a fixed 20s guess instead). Poll the real
 *  signal with a generous timeout. */
async function waitForKitAskIdle(frameLoc, timeout = 60_000) {
  await frameLoc
    .locator('.kit-ask-compose[data-busy="false"]')
    .waitFor({ state: 'attached', timeout });
}

async function installApp(name, appId) {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp('^Preview ' + name) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
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

/** Environment trap (this machine, 2026-07-12): the default active runner on
 *  a fresh vault is `codex` (settingsProvidersData.ts falls through to
 *  'codex' whenever `agent.runner.kind` is unset). The `codex` CLI shows up
 *  as "connected" (its `--version` wrapper runs fine) but `codex app-server`
 *  spawns a vendored binary that's missing on this box (ENOENT), so every
 *  real turn dies instantly with an error bubble instead of a real answer.
 *  `claude` (Claude Code) works. Force it active via Settings before
 *  exercising any real turn. Not a product bug — a local CLI install issue —
 *  but flows must route around it to be meaningful. */
async function ensureClaudeCodeActive() {
  await page
    .getByRole('button', { name: /^Settings/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Agents' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: 'Agents' }).click();
  await page.waitForTimeout(400);
  const claudeTab = page.getByRole('tab', { name: 'Claude Code' });
  await claudeTab.waitFor({ state: 'visible', timeout: 10_000 });
  const alreadyActive = (await claudeTab.getAttribute('aria-selected')) === 'true';
  if (!alreadyActive) {
    await claudeTab.click();
    await page.waitForTimeout(500);
  }
  console.log(`[chat02] active agent ensured Claude Code (was already active: ${alreadyActive})`);
  await navTo(page, 'Home');
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[chat02] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'ensure-claude-code-active',
      'Force Claude Code active (codex CLI is broken in this environment)',
      async () => {
        await ensureClaudeCodeActive();
      },
    );

    await step('install-open-tasks', 'Install + open Tasks, open Ask panel', async () => {
      await installApp('Tasks', 'tasks');
      await shot('00-tasks-installed');
    });

    let frameLoc = await openApp('tasks');

    await step('open-ask-panel', 'Open the Ask panel', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc
        .locator('.kit-ask-panel[role="dialog"]')
        .waitFor({ state: 'visible', timeout: 10_000 });
      await shot('01-ask-panel-open');
    });

    await step(
      'history-button-toggles',
      'History button toggles the in-panel history view',
      async () => {
        const histBtn = frameLoc.locator('.kit-ask-history-btn');
        await histBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await histBtn.click();
        const histView = frameLoc.locator('.kit-ask-history');
        const hidden = await histView.evaluate((el) => el.hidden);
        assert(!hidden, 'history view did not become visible after clicking the History button');
        const pressed = await histBtn.getAttribute('aria-pressed');
        assert(pressed === 'true', 'History button aria-pressed did not flip to true');
        await shot('02-history-view-open-empty');
        // Toggle back to chat view.
        await histBtn.click();
        const hiddenAgain = await histView.evaluate((el) => el.hidden);
        assert(hiddenAgain, 'history view did not hide after toggling back');
        await shot('03-history-view-closed');
      },
    );

    await step(
      'send-message',
      'Send a message; busy contract engages (data-busy=true, send disabled) then clears',
      async () => {
        const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
        await input.fill('How many tasks are open right now?');
        await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
        const userBubble = frameLoc.locator('.kit-msg.user').last();
        await userBubble.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('04-message-sent');
        // Busy engages shortly after submit — proves the whole-turn contract
        // (not just the old pre-first-token typing indicator).
        await frameLoc
          .locator('.kit-ask-compose[data-busy="true"]')
          .waitFor({ state: 'attached', timeout: 5_000 });
        const sendBtnDisabled = await frameLoc
          .locator('.kit-ask-send[aria-label="Send"]')
          .isDisabled();
        assert(
          sendBtnDisabled,
          'send button should be disabled while .kit-ask-compose[data-busy="true"]',
        );
        await shot('04a-busy-engaged');
        // Wait for the real turn to finish and be recorded server-side —
        // history reads later in this flow depend on recordTurn having run.
        await waitForKitAskIdle(frameLoc);
        await shot('04b-turn-complete');
      },
    );

    await step(
      'history-shows-conversation',
      'Reopening History shows this conversation in the list',
      async () => {
        const histBtn = frameLoc.locator('.kit-ask-history-btn');
        await histBtn.click();
        const rows = frameLoc.locator('.kit-ask-history-item');
        await rows.first().waitFor({ state: 'visible', timeout: 10_000 });
        const count = await rows.count();
        assert(count >= 1, 'history list is empty after sending a message');
        await shot('05-history-list-populated');
        // Back to chat.
        await histBtn.click();
      },
    );

    await step(
      'attach-file-in-compose',
      'Attach a file via the paperclip button, chip appears',
      async () => {
        const tmpFile = path.join(OUT_DIR, 'chat02-sample.txt');
        await fs.writeFile(tmpFile, 'kit ask attachment sample\n');
        const fileInput = frameLoc.locator('.kit-ask-file');
        await fileInput.setInputFiles(tmpFile);
        const pendingChip = frameLoc.locator('.kit-ask-pending-name', {
          hasText: 'chat02-sample.txt',
        });
        await pendingChip.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('06-pending-attachment-chip');
      },
    );

    await step(
      'send-with-attachment',
      'Send with the attachment; chip renders in the sent bubble',
      async () => {
        const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
        await input.fill('See attached file');
        await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
        const sentChip = frameLoc.locator('.kit-ask-msg-att', { hasText: 'chat02-sample.txt' });
        await sentChip.first().waitFor({ state: 'visible', timeout: 10_000 });
        await shot('07-attachment-in-sent-bubble');
        await waitForKitAskIdle(frameLoc);
        await shot('07b-turn-complete');
      },
    );

    let pickedKitModelName = null;

    await step(
      'kit-model-picker-default-label',
      'Ask panel model picker (.kit-ask-model-btn) shows "Default" with no override',
      async () => {
        const btn = frameLoc.locator('.kit-ask-model-btn');
        await btn.waitFor({ state: 'visible', timeout: 5_000 });
        assert(
          (await btn.getAttribute('aria-label')) === 'Model',
          'kit model button missing aria-label="Model"',
        );
        assert(
          (await btn.getAttribute('aria-haspopup')) === 'menu',
          'kit model button missing aria-haspopup="menu"',
        );
        const label = (await frameLoc.locator('.kit-ask-model-label').textContent())?.trim() ?? '';
        console.log(`[chat02] kit ask model label: "${label}"`);
        assert(label === 'Default', `expected model label "Default", got "${label}"`);
        await shot('08-kit-model-picker-default');
      },
    );

    await step(
      'kit-model-picker-open-menu',
      'Opening the menu shows role=menu with "Use default" first',
      async () => {
        const btn = frameLoc.locator('.kit-ask-model-btn');
        await btn.click();
        assert(
          (await btn.getAttribute('aria-expanded')) === 'true',
          'aria-expanded did not flip to true when opened',
        );
        const menu = frameLoc.locator('.kit-ask-model-menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        assert((await menu.getAttribute('role')) === 'menu', 'kit model menu missing role="menu"');
        const items = frameLoc.locator('.kit-ask-model-item');
        const count = await items.count();
        assert(count >= 1, 'kit model menu has no menuitemradio items');
        const firstText = (await items.first().textContent())?.trim() ?? '';
        assert(
          firstText.startsWith('Use default'),
          `first kit model item should read "Use default...", got "${firstText}"`,
        );
        assert(
          (await items.first().getAttribute('aria-checked')) === 'true',
          'first item ("Use default") should be aria-checked when no override is set',
        );
        await shot('09-kit-model-picker-menu-open');
      },
    );

    await step(
      'kit-model-picker-select-non-default',
      'Pick a non-default model; label updates',
      async () => {
        const items = frameLoc.locator('.kit-ask-model-item');
        const count = await items.count();
        if (count < 2) {
          console.log(
            '[chat02] only "Use default" is available in the kit ask catalog — skipping selection/persistence steps',
          );
          await frameLoc.locator('.kit-ask-model-btn').click(); // close the menu
          return;
        }
        const target = items.nth(1);
        pickedKitModelName = (await target.textContent())?.trim() ?? null;
        console.log(`[chat02] picking kit ask model: "${pickedKitModelName}"`);
        await target.click();
        await page.waitForTimeout(500);
        const label = (await frameLoc.locator('.kit-ask-model-label').textContent())?.trim() ?? '';
        console.log(`[chat02] kit ask model label after pick: "${label}"`);
        assert(
          label === pickedKitModelName,
          `label did not update to the picked model: expected "${pickedKitModelName}", got "${label}"`,
        );
        await shot('10-kit-model-picker-selected');
      },
    );

    if (pickedKitModelName) {
      await step(
        'kit-model-picker-persists-on-reopen',
        'Close + reopen the Ask panel; the picked model label persists (PUT + reopen-refetch works)',
        async () => {
          // Close the whole panel (not just the menu) and reopen it — the
          // picker's `load()` re-fetches `GET _turn/model` on every panel `open()`.
          await frameLoc.locator('.kit-ask-x').click();
          await frameLoc
            .locator('.kit-ask-panel[role="dialog"]')
            .waitFor({ state: 'hidden', timeout: 5_000 })
            .catch(() => undefined);
          await frameLoc.locator('#kitAskBtn').click();
          await frameLoc
            .locator('.kit-ask-panel[role="dialog"]')
            .waitFor({ state: 'visible', timeout: 10_000 });
          const label =
            (await frameLoc.locator('.kit-ask-model-label').textContent())?.trim() ?? '';
          console.log(
            `[chat02] kit ask model label after reopen: "${label}" (expected "${pickedKitModelName}")`,
          );
          assert(
            label === pickedKitModelName,
            `model label did not persist across a panel reopen: expected "${pickedKitModelName}", got "${label}"`,
          );
          await shot('11-kit-model-picker-persisted-on-reopen');
        },
      );

      await step(
        'kit-model-picker-reset-to-default',
        'Reset the picker to "Use default"',
        async () => {
          const btn = frameLoc.locator('.kit-ask-model-btn');
          await btn.click();
          const menu = frameLoc.locator('.kit-ask-model-menu');
          await menu.waitFor({ state: 'visible', timeout: 5_000 });
          await frameLoc.locator('.kit-ask-model-item').first().click();
          await page.waitForTimeout(500);
          const label =
            (await frameLoc.locator('.kit-ask-model-label').textContent())?.trim() ?? '';
          assert(label === 'Default', `expected label "Default" after reset, got "${label}"`);
          await shot('12-kit-model-picker-reset');
        },
      );
    } else {
      console.log(
        '[chat02] skipping persistence + reset steps (no non-default model was available to select)',
      );
    }

    await step(
      'attach-magic-token-file',
      'Attach a text file with a magic token; the real model reads it back (multimodal fix)',
      async () => {
        const tmpFile = path.join(OUT_DIR, 'chat02-magic.txt');
        await fs.writeFile(tmpFile, 'The code word is MANGO-COMPASS-93.\n');
        const fileInput = frameLoc.locator('.kit-ask-file');
        await fileInput.setInputFiles(tmpFile);
        const pendingChip = frameLoc.locator('.kit-ask-pending-name', {
          hasText: 'chat02-magic.txt',
        });
        await pendingChip.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('13-magic-token-pending-chip');
        const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
        await input.fill(
          'What is the code word in the attached file? Reply with only the code word.',
        );
        await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
        const sentChip = frameLoc.locator('.kit-ask-msg-att', { hasText: 'chat02-magic.txt' });
        await sentChip.first().waitFor({ state: 'visible', timeout: 10_000 });
        await shot('14-magic-token-sent');
        await waitForKitAskIdle(frameLoc);
        // The multimodal fix (packages/agent-runtime/src/multimodal.ts) injects
        // textual attachments as fenced text blocks into the model's context —
        // this is the end-to-end proof through a real LLM turn, via the kit Ask surface.
        const log = frameLoc.locator('.kit-ask-log');
        const text = (await log.textContent()) ?? '';
        assert(
          text.includes('MANGO-COMPASS-93'),
          `kit ask reply did not contain the magic token from the attached file (multimodal fix regression?). Log tail: ${text.slice(-800)}`,
        );
        await shot('15-magic-token-reply-contains-token');
      },
    );

    await step(
      'kit-composer-visual-screenshot',
      'Screenshot of the redesigned kit Ask composer for visual review',
      async () => {
        await shot('16-kit-composer-visual-final');
      },
    );

    await step(
      'new-conversation-from-history',
      '"+ New conversation" clears the active thread',
      async () => {
        const histBtn = frameLoc.locator('.kit-ask-history-btn');
        await histBtn.click();
        const newBtn = frameLoc.locator('.kit-ask-history-new');
        await newBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await newBtn.click();
        await page.waitForTimeout(500);
        const log = frameLoc.locator('.kit-ask-log');
        const text = (await log.textContent()) ?? '';
        assert(
          !text.includes('See attached file'),
          'log still shows prior conversation text after "+ New conversation"',
        );
        await shot('08-new-conversation-cleared');
      },
    );

    await step(
      'reopen-past-conversation',
      'Reopen the earlier conversation from history -> transcript reloads',
      async () => {
        const histBtn = frameLoc.locator('.kit-ask-history-btn');
        const isHistoryOpen =
          (await frameLoc.locator('.kit-ask-history').evaluate((el) => el.hidden)) === false;
        if (!isHistoryOpen) await histBtn.click();
        const rows = frameLoc.locator('.kit-ask-history-item');
        await rows.first().waitFor({ state: 'visible', timeout: 10_000 });
        await rows.first().click();
        await page.waitForTimeout(1000);
        const log = frameLoc.locator('.kit-ask-log');
        const text = (await log.textContent()) ?? '';
        console.log(
          `[chat02] reloaded transcript text starts: ${JSON.stringify(text.slice(0, 200))}`,
        );
        assert(
          text.includes('open right now') || text.includes('attached file'),
          'selecting a past conversation from history did not reload its transcript',
        );
        await shot('09-reopened-transcript');
      },
    );

    // ---- Report ----
    console.log('\n================ KIT ASK HISTORY VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log('=================================================================');

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll chat02 steps PASSED.');
    }
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

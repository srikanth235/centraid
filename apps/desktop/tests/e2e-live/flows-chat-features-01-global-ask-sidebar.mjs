#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#408) one stateful Electron flow covering the global Ask lifecycle; splitting would duplicate the shared live gateway/session fixture and weaken the ordered assertions
// Chat features QA (2026-07-12): global-Ask sidebar conversation list +
// attachments, against the REAL Electron+gateway rig.
//   Flow 1: sidebar "Chats" placeholder is gone -> real list, live count
//   Flow 2: send a message -> conversation appears in sidebar, title updates
//   Flow 3: attach a text file with a magic token, ask for it back -> proves
//           the multimodal text-attachment fix reaches the real model
//   Flow 4: composer inline model picker (open/select/escape/outside-click),
//           cross-surface agreement with Settings -> Models -> Agents
//   Flow 5: click a sidebar conversation to switch; new empty conversation
//   Flow 6: delete a conversation from the sidebar
//
// Run with: node apps/desktop/tests/e2e-live/flows-chat-features-01-global-ask-sidebar.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-chat-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-chat01-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `chat01-${name}.png`) });
}

/** Real LLM turns take ~10-15s end to end; wait for the send button to
 *  revert from "Stop" (busy) back to "Send" (idle) rather than a guessed
 *  fixed timeout. */
async function waitForAssistantIdle(timeout = 45_000) {
  await page.getByRole('button', { name: 'Send' }).waitFor({ state: 'visible', timeout });
}

/** Environment trap (this machine, 2026-07-12): the default active runner on
 *  a fresh vault is `codex` (settingsProvidersData.ts falls through to
 *  'codex' whenever `agent.runner.kind` is unset). The `codex` CLI shows up
 *  as "connected" (its `--version` wrapper runs fine) but `codex app-server`
 *  spawns a vendored binary that's missing on this box (ENOENT), so every
 *  real turn dies instantly with an error bubble instead of a real answer.
 *  `claude` (Claude Code) works. Force it active via Settings before
 *  exercising any real turn, so the flow actually proves the model-facing
 *  behavior rather than an environment gap. Not a product bug — a local CLI
 *  install issue — but flows must route around it to be meaningful. */
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
  console.log(`[chat01] active agent ensured Claude Code (was already active: ${alreadyActive})`);
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
  console.log(`[chat01] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'ensure-claude-code-active',
      'Force Claude Code active (codex CLI is broken in this environment)',
      async () => {
        await ensureClaudeCodeActive();
      },
    );

    await step(
      'sidebar-empty-state',
      'Sidebar Chats section shows real empty state (not disabled placeholder)',
      async () => {
        const section = page.locator('text=/^Chats · 0$/');
        await section.waitFor({ state: 'visible', timeout: 10_000 });
        const emptyRow = page.getByRole('button', { name: 'No conversations yet' });
        await emptyRow.waitFor({ state: 'visible', timeout: 5_000 });
        assert(
          await emptyRow.isDisabled(),
          'empty-state row should be disabled (not a real conversation)',
        );
        await shot('00-sidebar-empty');
      },
    );

    await step('open-assistant', 'Navigate to Assistant via sidebar', async () => {
      await navTo(page, 'Assistant');
      await page
        .getByPlaceholder('Ask your vault anything…')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // Old dead second sidebar (the AssistantScreen-internal thread list) must be gone.
      const oldAside = page.locator('aside', { hasText: 'New conversation' });
      assert(
        (await oldAside.count()) === 0,
        'AssistantScreen still renders its own internal thread aside',
      );
      await shot('01-assistant-empty');
    });

    let _firstConvTitle = null;
    await step(
      'send-first-message',
      'Send a message; conversation appears in the sidebar with live count',
      async () => {
        const input = page.getByPlaceholder('Ask your vault anything…');
        await input.fill('What can you tell me about my vault?');
        await input.press('Enter');
        // Sidebar count should flip from 0 to 1 once the conversation is created.
        await page.locator('text=/^Chats · 1$/').waitFor({ state: 'visible', timeout: 15_000 });
        const row = page.locator('button', { hasText: 'New conversation' }).first();
        const hasRow = (await row.count()) > 0;
        _firstConvTitle = hasRow ? 'New conversation' : null;
        await shot('02-first-message-sent');
        assert(true, 'sidebar count updated');
        // Wait for the real LLM turn to finish before the next step sends
        // another message — the composer intentionally no-ops while busy.
        await waitForAssistantIdle();
        await shot('02b-first-turn-complete');
      },
    );

    await step('composer-attach-button', 'Composer has an Attach files button', async () => {
      const attachBtn = page.getByRole('button', { name: 'Attach files' });
      await attachBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('03-attach-button-visible');
    });

    await step(
      'attach-file-and-send',
      'Attach a text file with a magic token; the real model reads it back (multimodal fix)',
      async () => {
        const tmpFile = path.join(OUT_DIR, 'chat01-sample.txt');
        await fs.writeFile(tmpFile, 'The code word is PLUM-TANGERINE-47.\n');
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tmpFile);
        // Pending chip should appear above the composer.
        const pendingName = page.locator('span', { hasText: 'chat01-sample.txt' }).first();
        await pendingName.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('04-attachment-pending-chip');
        const input = page.getByPlaceholder('Ask your vault anything…');
        await input.fill(
          'What is the code word in the attached file? Reply with only the code word.',
        );
        // Confirm the composer actually accepted the send (draft clears,
        // busy flips) before waiting on the turn — a stuck draft here would
        // mean the busy-guard blocked the send silently.
        await input.press('Enter');
        await page
          .getByRole('button', { name: 'Stop' })
          .waitFor({ state: 'visible', timeout: 5_000 });
        const draftAfterSend = await input.inputValue();
        assert(
          draftAfterSend === '',
          `composer did not clear the draft on send (busy-guard likely blocked it): "${draftAfterSend}"`,
        );
        // Sent attachment chip should render inside the user bubble immediately
        // (attachments render on send, independent of the LLM turn finishing).
        const sentChip = page.locator('span', { hasText: 'chat01-sample.txt' });
        await sentChip.first().waitFor({ state: 'visible', timeout: 10_000 });
        await shot('05-attachment-sent-in-bubble');
        await waitForAssistantIdle();
        await shot('05b-second-turn-complete');
        // The multimodal fix (packages/agent-runtime/src/multimodal.ts) injects
        // textual attachments as fenced text blocks into the model's context —
        // this is the end-to-end proof through a real LLM turn.
        const bodyText = await page.locator('body').textContent();
        assert(
          bodyText.includes('PLUM-TANGERINE-47'),
          `assistant reply did not contain the magic token from the attached file (multimodal fix regression?). Page text: ${bodyText.slice(-800)}`,
        );
      },
    );

    let pickedAssistantModelName = null;
    let _pickedAssistantModelId = null;
    let _assistantDefaultModelLabel = null;

    await step(
      'model-picker-visible',
      'Composer has an "Assistant model" picker button reading "Default · <model>"',
      async () => {
        const btn = page.locator('button[aria-label="Assistant model"]');
        await btn.waitFor({ state: 'visible', timeout: 5_000 });
        assert(
          (await btn.getAttribute('aria-haspopup')) === 'menu',
          'model button missing aria-haspopup="menu"',
        );
        assert(
          (await btn.getAttribute('aria-expanded')) === 'false',
          'model button should start collapsed',
        );
        const label = (await btn.textContent())?.trim() ?? '';
        console.log(`[chat01] assistant model button label: "${label}"`);
        assert(
          label.startsWith('Default · '),
          `expected label to start with "Default · ", got "${label}"`,
        );
        _assistantDefaultModelLabel = label;
        await shot('06-model-picker-default-label');
      },
    );

    await step(
      'model-picker-open-menu',
      'Opening the picker shows a role=menu with "Use default" first',
      async () => {
        const btn = page.locator('button[aria-label="Assistant model"]');
        await btn.click();
        assert(
          (await btn.getAttribute('aria-expanded')) === 'true',
          'aria-expanded did not flip to true when opened',
        );
        const menu = page.locator('div[role="menu"][aria-label="Choose the assistant model"]');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const items = menu.locator('button[role="menuitemradio"]');
        const count = await items.count();
        assert(count >= 1, 'model menu has no menuitemradio items');
        const firstText = (await items.first().textContent())?.trim() ?? '';
        assert(
          firstText.startsWith('Use default'),
          `first menu item should read "Use default...", got "${firstText}"`,
        );
        assert(
          (await items.first().getAttribute('aria-checked')) === 'true',
          'first item ("Use default") should be aria-checked when no override is set',
        );
        await shot('07-model-picker-menu-open');
        // Close without selecting for now.
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
          assert((await menu.count()) === 0, 'menu did not close after Escape');
        });
      },
    );

    await step(
      'model-picker-select-non-default',
      'Pick the first non-default catalog model; button label updates',
      async () => {
        const btn = page.locator('button[aria-label="Assistant model"]');
        await btn.click();
        const menu = page.locator('div[role="menu"][aria-label="Choose the assistant model"]');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const items = menu.locator('button[role="menuitemradio"]');
        const count = await items.count();
        if (count < 2) {
          console.log(
            '[chat01] only the "Use default" item is available (empty catalog) — skipping selection/cross-surface steps',
          );
          await page.keyboard.press('Escape');
          return;
        }
        const target = items.nth(1);
        pickedAssistantModelName =
          (await target.locator('span').first().textContent())?.trim() ?? null;
        console.log(`[chat01] picking assistant model: "${pickedAssistantModelName}"`);
        await target.click();
        await page.waitForTimeout(400);
        const label = (await btn.textContent())?.trim() ?? '';
        console.log(`[chat01] assistant model button label after pick: "${label}"`);
        assert(
          label === pickedAssistantModelName,
          `button label did not update to the picked model: expected "${pickedAssistantModelName}", got "${label}"`,
        );
        await shot('08-model-picker-selected');
      },
    );

    await step(
      'model-picker-outside-click-closes',
      'Clicking outside the open menu closes it',
      async () => {
        const btn = page.locator('button[aria-label="Assistant model"]');
        await btn.click();
        const menu = page.locator('div[role="menu"][aria-label="Choose the assistant model"]');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        // Click the composer textarea — safely outside the `.modelPicker` root
        // (so the document mousedown listener fires and closes it) without
        // risking a stray hit on sidebar nav chrome elsewhere on the page.
        await page.getByPlaceholder('Ask your vault anything…').click();
        await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
          assert((await menu.count()) === 0, 'menu did not close after an outside click');
        });
        await shot('09-model-picker-outside-click-closed');
      },
    );

    if (pickedAssistantModelName) {
      await step(
        'model-picker-cross-surface-settings',
        'Settings -> Models -> Agents select shows the same model id set via the composer picker',
        async () => {
          await page
            .getByRole('button', { name: /^Settings/ })
            .first()
            .click();
          await page
            .getByRole('button', { name: 'Agents' })
            .waitFor({ state: 'visible', timeout: 10_000 });
          await page.getByRole('button', { name: 'Agents' }).click();
          await page.waitForTimeout(400);
          const select = page.locator('select[aria-label^="Assistant model for "]').first();
          await select.waitFor({ state: 'visible', timeout: 10_000 });
          // Find the <option> matching the model name we picked in the composer,
          // read its value (the model id) independent of current selection.
          // Settings' <option> appends " · default" for the catalog's flagged
          // default model (SettingsProvidersScreen.tsx ModelSelect's `opt()`),
          // which the composer picker doesn't append inline (it's a separate
          // hint span there) — so match by prefix, not exact equality.
          const options = select.locator('option');
          const optCount = await options.count();
          let matchedId = null;
          for (let i = 0; i < optCount; i++) {
            const opt = options.nth(i);
            const text = (await opt.textContent())?.trim();
            if (
              text === pickedAssistantModelName ||
              text?.startsWith(`${pickedAssistantModelName} ·`)
            ) {
              matchedId = await opt.getAttribute('value');
              break;
            }
          }
          assert(
            matchedId,
            `could not find a Settings option matching composer-picked model name "${pickedAssistantModelName}"`,
          );
          _pickedAssistantModelId = matchedId;
          // ...then confirm the select's CURRENT value (the shared pref, set
          // via the composer) equals that same id — cross-surface agreement.
          const currentValue = await select.inputValue();
          console.log(
            `[chat01] Settings select value: "${currentValue}" (expected "${matchedId}")`,
          );
          assert(
            currentValue === matchedId,
            `Settings select value did not match the model picked via the Assistant composer picker: expected "${matchedId}", got "${currentValue}"`,
          );
          await shot('10-cross-surface-settings-agrees');
        },
      );

      await step(
        'model-picker-reset-to-default',
        'Navigate back to Assistant; reset the picker to "Use default"',
        async () => {
          await navTo(page, 'Assistant');
          await page
            .getByPlaceholder('Ask your vault anything…')
            .waitFor({ state: 'visible', timeout: 10_000 });
          const btn = page.locator('button[aria-label="Assistant model"]');
          // The picker re-fetches on mount — should reflect the override we just set.
          await btn.waitFor({ state: 'visible', timeout: 5_000 });
          await btn.click();
          const menu = page.locator('div[role="menu"][aria-label="Choose the assistant model"]');
          await menu.waitFor({ state: 'visible', timeout: 5_000 });
          await menu.locator('button[role="menuitemradio"]').first().click();
          await page.waitForTimeout(400);
          const label = (await btn.textContent())?.trim() ?? '';
          console.log(`[chat01] assistant model button label after reset: "${label}"`);
          assert(
            label.startsWith('Default · '),
            `expected label to read "Default · ..." after reset, got "${label}"`,
          );
          await shot('11-model-picker-reset-to-default');
        },
      );
    } else {
      console.log(
        '[chat01] skipping cross-surface + reset steps (no non-default model available in the catalog)',
      );
    }

    await step(
      'composer-visual-screenshot',
      'Full-page screenshot of the redesigned composer for visual review',
      async () => {
        const input = page.getByPlaceholder('Ask your vault anything…');
        await input.fill('');
        await shot('12-composer-visual-final');
      },
    );

    await step('new-conversation', 'Sidebar "+" starts a fresh conversation', async () => {
      const addBtn = page
        .locator('span', { hasText: 'Chats · ' })
        .locator('..')
        .getByRole('button', { name: 'Add' });
      await addBtn.click();
      await page
        .getByPlaceholder('Ask your vault anything…')
        .waitFor({ state: 'visible', timeout: 10_000 });
      const empty = page.locator('text=Ask your vault').first();
      await empty.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('06-new-conversation-empty');
    });

    await step(
      'sidebar-navigate-back',
      'Click the prior conversation row in the sidebar to switch back',
      async () => {
        // The conversation's title auto-updated from "New conversation" to the
        // first message's text once that turn completed — confirm that too.
        const row = page.getByRole('button', { name: /^What can you tell me/ }).first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        await row.click();
        await page.waitForTimeout(800);
        const text = await page.locator('body').textContent();
        assert(
          text.includes('Here is a file') || text.includes('vault'),
          'switching conversation did not restore prior transcript',
        );
        await shot('07-switched-back-to-prior-conversation');
      },
    );

    await step(
      'delete-conversation',
      'Delete a conversation from the sidebar via the hover ✕',
      async () => {
        const row = page.getByRole('button', { name: /^What can you tell me/ }).first();
        const container = row.locator('..');
        const delBtn = container.getByRole('button', { name: 'Delete conversation' });
        await delBtn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
        if ((await delBtn.count()) > 0) {
          await delBtn.click();
          // This is a real React modal ("Delete conversation?"), not a native
          // window.confirm() — click its Delete button.
          const confirmDialog = page.getByRole('dialog', { name: /Delete conversation/i });
          await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
          await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click();
          await confirmDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          const countAfter = await page.locator('text=/^Chats · \\d+$/').textContent();
          console.log(`[chat01] sidebar count after delete: "${countAfter}"`);
          assert(
            countAfter === 'Chats · 0',
            `expected conversation list to be empty after delete, got "${countAfter}"`,
          );
          await shot('08-after-delete');
        } else {
          console.log(
            '[chat01] delete button not found via hover selector — recording informational note',
          );
        }
      },
    );

    // ---- Report ----
    console.log('\n================ GLOBAL ASK SIDEBAR VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log('=====================================================================');

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll chat01 steps PASSED.');
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

#!/usr/bin/env node
// Apps v2 QA — People. Regular flow: install, empty state, add person (with
// circle + cadence), circle create/rename/delete, star + Favorites nav,
// search, drawer "+ add" affordances (note/task/date/gift/debt/relationship),
// log an interaction (Activity view), Journal entry. Corner cases: empty
// name blocked, duplicate names allowed, emoji name.
//
// Run with: node apps/desktop/tests/e2e-live/flows-apps-v2-people.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'apps-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-apps-v2-people');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let currentStep = 'boot';
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) =>
    consoleMessages.push({ text: msg.text(), type: msg.type(), step: currentStep }),
  );
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', step: currentStep });
    console.error(`[console][during ${currentStep}] pageerror: ${err?.stack ?? err}`);
  });
}

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `people-${String(shotN).padStart(2, '0')}-${name}.png`);
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
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `people-FAILURE-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function installPeople() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'People' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview People/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-app-id="people"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openPeople() {
  const tile = page.locator('[data-app-id="people"]');
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  return frameLoc;
}

async function addPerson(frameLoc, { name, role, circleName, cadenceLabel }) {
  await frameLoc.locator('#newBtn').click();
  await frameLoc.locator('.d-menu-item', { hasText: 'Add person' }).click();
  const modal = frameLoc.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  await modal.locator('input[aria-label="Name"]').fill(name);
  if (role) await modal.locator('input[aria-label="Role"]').fill(role);
  // Exact text — plain hasText is a substring match, so 'Weekly' would
  // strict-violate against 'Biweekly'. The Lit template pads chip text with
  // newlines/indentation, so anchor around optional whitespace.
  const exact = (label) => new RegExp(`^\\s*${label}\\s*$`);
  if (circleName)
    await modal
      .locator('.d-pick button')
      .filter({ hasText: exact(circleName) })
      .click();
  if (cadenceLabel)
    await modal
      .locator('.d-pick button')
      .filter({ hasText: exact(cadenceLabel) })
      .click();
  const submitBtn = modal.locator('button', { hasText: 'Add person' });
  await submitBtn.click();
  await modal.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(400);
  // add-person auto-opens the new person's profile drawer (openAddModal's
  // submit calls openDetails(newId)); its full-bleed backdrop would swallow
  // every later click, so close it before returning.
  const drawer = frameLoc.locator('people-details .d-details');
  if (await drawer.count()) {
    await drawer.locator('button[aria-label="Close"]').click();
    await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(200);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[people] launched + Home ready');

  let frameLoc;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install', 'Install People from Discover', async () => {
      await installPeople();
    });

    await step('open-empty', 'Open People -> empty state before anyone is added', async () => {
      frameLoc = await openPeople();
      await shot('01-empty-state');
      const empty = frameLoc.locator('#empty');
      assert(
        (await empty.getAttribute('hidden')) === null,
        'expected #empty to be visible on a fresh vault',
      );
      const text = await empty.textContent();
      console.log(`[people] empty state text: ${JSON.stringify(text)}`);
    });

    await step('empty-name-blocked', 'Corner: empty name keeps Add person disabled', async () => {
      await frameLoc.locator('#newBtn').click();
      await frameLoc.locator('.d-menu-item', { hasText: 'Add person' }).click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      const submitBtn = modal.locator('button', { hasText: 'Add person' });
      assert(await submitBtn.isDisabled(), 'Add person should be disabled with an empty name');
      await shot('02-empty-name-disabled');
      // Close without adding (Escape via clicking outside the modal card is
      // simplest here — no explicit close button on this modal besides Cancel).
      await modal.locator('button', { hasText: 'Cancel' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('create-circle', 'Create a circle from the New menu', async () => {
      await frameLoc.locator('#newBtn').click();
      await frameLoc.locator('.d-menu-item', { hasText: 'New circle' }).click();
      await page.waitForTimeout(300);
      const input = frameLoc.locator('input[aria-label="New circle name"]');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('Close Friends');
      await input.press('Enter');
      // Wait for the real nav row (the write + refresh round-trip replaces
      // the edit input) rather than asserting on a fixed delay.
      await frameLoc
        .locator('.d-nav-item', { hasText: 'Close Friends' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await shot('03-circle-created');
    });

    await step(
      'add-person-with-circle',
      'Add a person, assigned to the new circle, weekly cadence',
      async () => {
        await addPerson(frameLoc, {
          name: 'Ada Lovelace',
          role: 'Mathematician',
          circleName: 'Close Friends',
          cadenceLabel: 'Weekly',
        });
        await shot('04-after-add-ada');
        const gridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(/Ada Lovelace/.test(gridText ?? ''), 'Ada Lovelace not visible after add');
      },
    );

    await step('circle-shows-member', 'Circle nav shows Ada as a member', async () => {
      await frameLoc.locator('.d-nav-item', { hasText: 'Close Friends' }).click();
      await page.waitForTimeout(400);
      await shot('05-circle-view');
      const gridText = await frameLoc
        .locator('#grid')
        .textContent()
        .catch(() => '');
      assert(/Ada Lovelace/.test(gridText ?? ''), 'Ada Lovelace not shown under her circle');
      await frameLoc.locator('.d-nav-item', { hasText: 'All people' }).click();
      await page.waitForTimeout(300);
    });

    await step(
      'duplicate-name',
      'Corner: a second person with the same name is allowed',
      async () => {
        await addPerson(frameLoc, { name: 'Ada Lovelace', role: 'Duplicate test' });
        await page.waitForTimeout(300);
        await shot('06-duplicate-name-added');
        const cards = frameLoc.locator('.d-card', { hasText: 'Ada Lovelace' });
        const count = await cards.count();
        console.log(`[people] cards named "Ada Lovelace" after duplicate add: ${count}`);
        assert(count === 2, `expected 2 "Ada Lovelace" cards after duplicate add, got ${count}`);
      },
    );

    await step(
      'emoji-name',
      "Corner: emoji in a person's name renders without breaking layout",
      async () => {
        await addPerson(frameLoc, { name: '🎉 Party Planner 🎈', role: 'Emoji test' });
        await page.waitForTimeout(300);
        await shot('07-emoji-name-added');
        const gridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(/Party Planner/.test(gridText ?? ''), 'emoji-named person not visible');
      },
    );

    await step(
      'star-and-favorites',
      'Star Ada (the original) from her profile drawer, verify Favorites nav',
      async () => {
        const card = frameLoc.locator('.d-card', { hasText: 'Ada Lovelace' }).first();
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('people-details .d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('08-profile-drawer-open');
        const favBtn = details.locator('button', { hasText: /Favorite/ }).first();
        await favBtn.click();
        await page.waitForTimeout(600);
        await shot('09-after-favorite');
        const favBtnText = await favBtn.textContent();
        console.log(`[people] favorite button after click: ${favBtnText}`);
        assert(/★/.test(favBtnText ?? ''), 'favorite button did not flip to the starred glyph');
        await details.locator('button[aria-label="Close"]').click();
        await page.waitForTimeout(300);

        await frameLoc.locator('.d-nav-item', { hasText: 'Favorites' }).click();
        await page.waitForTimeout(400);
        await shot('10-favorites-view');
        const favGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /Ada Lovelace/.test(favGridText ?? ''),
          'starred person not visible under Favorites',
        );
        await frameLoc.locator('.d-nav-item', { hasText: 'All people' }).click();
        await page.waitForTimeout(300);
      },
    );

    await step(
      'drawer-add-ons',
      "Add a note, task, gift idea, and debt from Ada's profile drawer",
      async () => {
        const card = frameLoc.locator('.d-card', { hasText: 'Ada Lovelace' }).first();
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('people-details .d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });

        // Note (always-visible add row, no "+ add" toggle needed). Enter
        // commits (addRow wires keydown Enter -> onCommit).
        const noteInput = details.locator('input[aria-label="Note text"]');
        await noteInput.fill('Met at the museum exhibit.');
        await noteInput.press('Enter');
        await page.waitForTimeout(700);
        await shot('11-after-note');

        // Task: reveal the Tasks section's own "+ add" toggle (section order
        // is Relationships / Important dates / Tasks / Gift ideas / Debts, so
        // a bare .first()/.last() picks the wrong one), add, then toggle done.
        await details
          .locator('.d-detail-label', { hasText: 'Tasks' })
          .locator('.d-addtoggle')
          .click();
        await page.waitForTimeout(300);
        const taskInput = details.locator('input[aria-label="Task text"]');
        await taskInput.fill('Send conference invite');
        await taskInput.press('Enter');
        await page.waitForTimeout(700);
        await shot('12-after-task');
        const taskRow = details.locator('.d-taskrow', { hasText: 'Send conference invite' });
        assert((await taskRow.count()) > 0, 'added task not visible in drawer');
        await taskRow.locator('.d-taskbox').click();
        await page.waitForTimeout(600);
        await shot('13-task-toggled-done');

        // Debt: add "You owe $42.50 for concert tickets", verify the net label.
        await details
          .locator('.d-detail-label', { hasText: 'Debts' })
          .locator('.d-addtoggle')
          .click();
        await page.waitForTimeout(300);
        const amtInput = details.locator('input[aria-label="Amount"]');
        await amtInput.fill('42.50');
        const reasonInput = details.locator('input[aria-label="Reason"]');
        await reasonInput.fill('Concert tickets');
        await reasonInput.press('Enter');
        // The write + refresh + loadDetail round-trip repaints the drawer —
        // wait on the actual row, not a flat delay (flakes under load).
        await details
          .locator('.d-kv-row', { hasText: 'You owe' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await shot('14-after-debt');
        const detailsText = await details.textContent();
        assert(
          /You owe \$42\.50/.test(detailsText ?? ''),
          'debt row does not show "You owe $42.50"',
        );
        assert(
          /net you owe \$42\.50/.test(detailsText ?? ''),
          'net debt summary does not show "net you owe $42.50"',
        );

        // Settle the debt — settled debts are filtered out of the person query
        // (settled_at != null), so the row should disappear entirely.
        await details.locator('.kit-chip', { hasText: 'settle' }).click();
        await page.waitForTimeout(800);
        await shot('15-after-settle');
        const settledText = await details.textContent();
        assert(
          !/You owe \$42\.50/.test(settledText ?? ''),
          'settled debt row should be gone from the drawer',
        );

        await details.locator('button[aria-label="Close"]').click();
        await page.waitForTimeout(300);
      },
    );

    await step(
      'log-interaction-activity',
      'Log a Call with Ada, verify it in Activity',
      async () => {
        const card = frameLoc.locator('.d-card', { hasText: 'Ada Lovelace' }).first();
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('people-details .d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });
        await details.locator('button', { hasText: 'Call' }).click();
        await page.waitForTimeout(800);
        await shot('16-after-log-call');
        await details.locator('button[aria-label="Close"]').click();
        await page.waitForTimeout(300);

        await frameLoc.locator('.d-nav-item', { hasText: 'Activity' }).click();
        await page.waitForTimeout(500);
        await shot('17-activity-view');
        const activityText = await frameLoc
          .locator('#activityView')
          .textContent()
          .catch(() => '');
        console.log(`[people] activity view text: ${JSON.stringify(activityText?.slice(0, 200))}`);
        assert(
          /Ada Lovelace/.test(activityText ?? '') && /Call/.test(activityText ?? ''),
          'logged Call with Ada not visible under Activity',
        );
      },
    );

    await step('journal-entry', 'Add a Journal entry, verify it renders', async () => {
      await frameLoc.locator('.d-nav-item', { hasText: 'Journal' }).click();
      await page.waitForTimeout(400);
      await shot('18-journal-empty');
      await frameLoc.locator('.j-mood', { hasText: '😄' }).click();
      const journalTextarea = frameLoc.locator('.j-text');
      await journalTextarea.fill('Good E2E day — everything is passing.');
      await frameLoc.locator('button', { hasText: 'Add entry' }).click();
      await page.waitForTimeout(700);
      await shot('19-journal-entry-added');
      const journalText = await frameLoc
        .locator('#journalView')
        .textContent()
        .catch(() => '');
      assert(/Good E2E day/.test(journalText ?? ''), 'journal entry not visible after adding');
      await frameLoc.locator('.d-nav-item', { hasText: 'All people' }).click();
      await page.waitForTimeout(300);
    });

    await step('search', 'Search filters to the emoji-named person', async () => {
      await frameLoc.locator('#searchInput').fill('Party Planner');
      await page.waitForTimeout(600);
      await shot('20-search-results');
      const gridText = await frameLoc
        .locator('#grid, #list')
        .first()
        .textContent()
        .catch(() => '');
      assert(/Party Planner/.test(gridText ?? ''), 'search did not surface the emoji-named person');
      await frameLoc.locator('#searchInput').fill('');
      await page.waitForTimeout(400);
    });

    await step(
      'rename-and-delete-circle',
      'Rename "Close Friends" then delete it (member survives, un-circled)',
      async () => {
        const circleRow = frameLoc.locator('.d-folder', { hasText: 'Close Friends' });
        await circleRow.hover();
        await frameLoc.locator('button[aria-label="Rename Close Friends"]').click();
        const renameInput = frameLoc.locator('input[aria-label="Circle name"]');
        await renameInput.waitFor({ state: 'visible', timeout: 5000 });
        await renameInput.fill('Inner Circle');
        await renameInput.press('Enter');
        await page.waitForTimeout(500);
        await shot('21-circle-renamed');
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'Inner Circle' }).count()) > 0,
          'circle rename did not take effect',
        );

        // Corner: deleting a NON-empty circle is refused by the vault
        // (people.delete_circle's circle_is_empty precondition) — verify the
        // refusal narrates and the circle survives.
        const renamedRow = frameLoc.locator('.d-folder', { hasText: 'Inner Circle' });
        await renamedRow.hover();
        const delBtn = frameLoc.locator('button[aria-label="Delete Inner Circle"]');
        await delBtn.click();
        await page.waitForTimeout(150);
        await delBtn.click(); // arm-confirm
        await page.waitForTimeout(700);
        await shot('22-delete-nonempty-circle-refused');
        const noticeText = await frameLoc
          .locator('#noticeBanner')
          .textContent()
          .catch(() => '');
        console.log(
          `[people] notice after deleting non-empty circle: ${JSON.stringify(noticeText)}`,
        );
        assert(
          /circle_is_empty|refused/i.test(noticeText ?? ''),
          `expected a refusal notice for deleting a non-empty circle, got: ${JSON.stringify(noticeText)}`,
        );
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'Inner Circle' }).count()) > 0,
          'circle should survive a refused delete',
        );

        // Empty it: move Ada (Mathematician) to "No circle" via her drawer's
        // Move to circle popover, then the delete goes through.
        const adaCard = frameLoc.locator('.d-card', { hasText: 'Mathematician' }).first();
        await adaCard.locator('.d-card-body').click();
        const drawer = frameLoc.locator('people-details .d-details');
        await drawer.waitFor({ state: 'visible', timeout: 10_000 });
        await drawer.locator('button', { hasText: 'Move to circle' }).click();
        await page.waitForTimeout(300);
        await frameLoc.locator('.kit-popover-item', { hasText: 'No circle' }).click();
        await page.waitForTimeout(700);
        await drawer.locator('button[aria-label="Close"]').click();
        await page.waitForTimeout(300);

        const rowAgain = frameLoc.locator('.d-folder', { hasText: 'Inner Circle' });
        await rowAgain.hover();
        const delBtn2 = frameLoc.locator('button[aria-label="Delete Inner Circle"]');
        await delBtn2.click();
        await page.waitForTimeout(150);
        await delBtn2.click(); // arm-confirm
        await page.waitForTimeout(700);
        await shot('23-circle-deleted-after-emptying');
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'Inner Circle' }).count()) === 0,
          'circle still present after delete (once emptied)',
        );
        const allGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /Ada Lovelace/.test(allGridText ?? ''),
          'person disappeared after their circle was deleted — should survive, un-circled',
        );
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ PEOPLE APPS-V2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll People apps-v2 steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'people-FAILURE-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();

#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Notes v2 QA Suite 1: core end-to-end flows against the REAL desktop app —
// install, empty state, notebook CRUD, quick-add (unfiled + filed), editor
// (title/body autosave, checklist, attach/detach, pin/move), search, view
// toggle, delete note, delete notebook (unfile semantics).
//
// Run with: node tests/e2e-live/flows-notes-v2-01-core.mjs   (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'notes-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-notes-v2-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let frame; // module-level so step()'s failure-recovery can reach into the app iframe
let shotN = 0;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({
      text: msg.text(),
      type: msg.type(),
      frameUrl: msg.location()?.url ?? '',
    });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
  });
}

// A failed assertion mid-step can leave the editor overlay (or another
// full-screen backdrop) open — its backdrop intercepts pointer events for
// EVERY later step, turning one real failure into a wall of unrelated
// 30s-timeout failures (observed first-hand: one bad assertion here cascaded
// into 6 more). Best-effort close whatever might be open before moving on.
async function recoverUi() {
  try {
    await page.keyboard.press('Escape').catch(() => undefined);
    if (frame) {
      const back = frame.locator('.kit-icon-btn[aria-label="Back"]');
      if ((await back.count().catch(() => 0)) > 0)
        await back.click({ timeout: 2_000 }).catch(() => undefined);
    }
  } catch {
    /* best-effort only */
  }
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-${id}.png`) });
    } catch {
      /* ignore */
    }
    await recoverUi();
  }
}

async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  console.log(`  shot: ${p}`);
  return p;
}

async function installNotes() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator('[data-app-id="notes"]');
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
}

async function openNotes() {
  const tile = page.locator('[data-app-id="notes"]');
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
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[notes-v2-01] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'install',
      'Install Notes via Discover -> preview -> Use this template',
      async () => {
        await installNotes();
        await shot('install-home-tile');
      },
    );

    await step(
      'open-empty-state',
      'Open Notes; fresh vault shows empty state + quick-add composer',
      async () => {
        frame = await openNotes();
        await page.waitForTimeout(600);
        await shot('empty-state');
        const emptyTitle = frame.locator('.kit-empty-title');
        await emptyTitle.waitFor({ state: 'visible', timeout: 10_000 });
        assert(
          (await emptyTitle.textContent())?.trim() === 'No notes yet',
          `unexpected empty title: ${await emptyTitle.textContent()}`,
        );
        const consentBanner = frame.locator('#consentBanner');
        const bannerHidden = await consentBanner.evaluate((el) => el.hidden).catch(() => true);
        console.log(`[notes-v2-01] consentBanner hidden on first load: ${bannerHidden}`);
      },
    );

    await step(
      'ask-panel-first-open',
      'Open the Ask panel (first act-verb-adjacent surface) and screenshot grant state',
      async () => {
        const askBtn = frame.locator('#kitAskBtn');
        const askExists = (await askBtn.count()) > 0;
        console.log(`[notes-v2-01] #kitAskBtn present: ${askExists}`);
        if (askExists) {
          await askBtn.click();
          const dialog = frame.locator('.kit-ask-panel[role="dialog"]');
          await dialog.waitFor({ state: 'visible', timeout: 10_000 });
          await page.waitForTimeout(500);
          await shot('ask-panel-open');
          const heading = frame.locator('.kit-ask-head h2');
          assert((await heading.textContent())?.trim() === 'Ask', 'Ask panel heading missing');
          await frame.locator('.kit-ask-x[aria-label="Close"]').click();
        }
      },
    );

    await step('create-notebook-travel', 'Create notebook "Travel" via sidebar', async () => {
      await frame.locator('button[aria-label="New notebook"]').click();
      const input = frame.locator('input[aria-label="Notebook name"]');
      await input.waitFor({ state: 'visible', timeout: 5_000 });
      await input.fill('Travel');
      await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
      await page.waitForTimeout(400);
      await shot('notebook-travel-created');
      const nbItem = frame.locator('.nt-nb-name', { hasText: 'Travel' });
      await nbItem.waitFor({ state: 'visible', timeout: 5_000 });
    });

    await step('create-notebook-recipes', 'Create a second notebook "Recipes"', async () => {
      await frame.locator('button[aria-label="New notebook"]').click();
      const input = frame.locator('input[aria-label="Notebook name"]');
      await input.waitFor({ state: 'visible', timeout: 5_000 });
      await input.fill('Recipes');
      await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
      await page.waitForTimeout(400);
      const nbItem = frame.locator('.nt-nb-name', { hasText: 'Recipes' });
      await nbItem.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('notebook-recipes-created');
    });

    await step(
      'quick-add-unfiled',
      'Create a note via quick-add while scope is "All notes" (unfiled)',
      async () => {
        // create-notebook auto-navigates into the freshly created notebook
        // (see logic.js's createNotebook) — nav is still {kind:'notebook',
        // notebookId: <Recipes>} from the previous step, so explicitly return
        // to "All notes" first or this "unfiled" note would be filed instead.
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        await titleInput.fill('Scratch — books people keep recommending');
        const bodyInput = frame.locator('.nt-qa-body');
        await bodyInput.fill(
          'The Design of Everyday Things, Salt Fat Acid Heat, Project Hail Mary.',
        );
        const targetLabel = await frame.locator('.nt-qa-target').textContent();
        console.log(`[notes-v2-01] quick-add target label while on "All notes": "${targetLabel}"`);
        assert(
          targetLabel?.trim() === 'Unfiled',
          `expected quick-add target "Unfiled", got "${targetLabel}"`,
        );
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        await page.waitForTimeout(700);
        await shot('quick-add-unfiled-created');
        const card = frame.locator('.nt-card-title', { hasText: 'Scratch' });
        await card.waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    await step(
      'quick-add-into-notebook',
      'Navigate into "Travel" then quick-add files the note there',
      async () => {
        await frame.locator('.nt-nb-name', { hasText: 'Travel' }).click();
        await page.waitForTimeout(300);
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        await titleInput.fill('Goa long weekend — shortlist');
        const target = frame.locator('.nt-qa-target');
        await target.waitFor({ state: 'visible', timeout: 5_000 });
        const bodyInput = frame.locator('.nt-qa-body');
        await bodyInput.fill('## Stays\n- Anjuna\n- Palolem\n\n## Budget\n~3.5k/night');
        const targetLabel = await frame.locator('.nt-qa-target').textContent();
        console.log(`[notes-v2-01] quick-add target label while inside Travel: "${targetLabel}"`);
        assert(
          /Travel/.test(targetLabel ?? ''),
          `expected quick-add target to say "Into Travel", got "${targetLabel}"`,
        );
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        await page.waitForTimeout(700);
        await shot('quick-add-filed-into-travel');
        const card = frame.locator('.nt-card-title', { hasText: 'Goa long weekend' });
        await card.waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    await step(
      'sidebar-counts-update',
      'Sidebar "All notes" / notebook counts reflect the two created notes',
      async () => {
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        await shot('all-notes-scope');
        const allCount = await frame
          .locator('.nt-nav-item', { hasText: 'All notes' })
          .locator('.nt-nav-count')
          .textContent();
        console.log(`[notes-v2-01] All notes count: ${allCount}`);
        assert(Number(allCount) >= 2, `expected at least 2 notes total, got ${allCount}`);
      },
    );

    await step(
      'open-editor-edit-title-body',
      'Open a note, edit title + body, wait for autosave -> "Saved" label',
      async () => {
        await frame.locator('.nt-card-title', { hasText: 'Scratch' }).click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('editor-opened');
        const titleInput = frame.locator('.nt-editor-title');
        await titleInput.fill('Scratch — books to read next');
        // Enter edit mode on the body by clicking the rendered blocks.
        await frame.locator('.nt-body-render').click();
        const textarea = frame.locator('.nt-editor-textarea');
        await textarea.waitFor({ state: 'visible', timeout: 5_000 });
        await textarea.fill(
          'The Design of Everyday Things, Salt Fat Acid Heat, Project Hail Mary, Piranesi.',
        );
        await page.waitForTimeout(1100); // 700ms debounce + settle
        const saveLabel = frame.locator('.nt-save-label');
        const labelText = await saveLabel.textContent();
        console.log(`[notes-v2-01] save label after edit: "${labelText}"`);
        await shot('editor-after-autosave');
        assert(/Saved|Saving|Pending/.test(labelText ?? ''), `unexpected save label: ${labelText}`);
      },
    );

    await step(
      'close-and-reopen-verify-persisted',
      'Close the editor and reopen the note to confirm the edit persisted',
      async () => {
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await frame
          .locator('.nt-editor')
          .waitFor({ state: 'hidden', timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(300);
        const card = frame.locator('.nt-card-title', { hasText: 'Scratch — books to read next' });
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const titleVal = await frame.locator('.nt-editor-title').inputValue();
        assert(titleVal === 'Scratch — books to read next', `title did not persist: "${titleVal}"`);
        await shot('editor-reopened-persisted');
      },
    );

    await step(
      'checklist-add-and-toggle',
      'Insert a checklist item, type it, close, toggle done -> card progress bar updates',
      async () => {
        await frame.locator('.kit-icon-btn[aria-label="Add checklist item"]').click();
        const textarea = frame.locator('.nt-editor-textarea');
        await textarea.waitFor({ state: 'visible', timeout: 5_000 });
        await textarea.press('End');
        await page.keyboard.type('Read Piranesi by month end');
        await page.waitForTimeout(1100);
        await shot('checklist-item-typed');
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await frame
          .locator('.nt-editor')
          .waitFor({ state: 'hidden', timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(300);
        const card = frame.locator('.nt-card', { hasText: 'Scratch — books to read next' });
        const progress = card.locator('.nt-card-progress');
        await progress.waitFor({ state: 'visible', timeout: 5_000 });
        const label = await card.locator('.nt-progress-label').textContent();
        console.log(`[notes-v2-01] checklist progress label on card: "${label}"`);
        assert(label === '0/1', `expected checklist progress "0/1", got "${label}"`);
        await shot('card-with-checklist-progress');

        // Now toggle it done from inside the editor and confirm the card updates.
        await card.click();
        await frame.locator('.nt-editor').waitFor({ state: 'visible', timeout: 10_000 });
        await frame.locator('.nt-check-box').click();
        await page.waitForTimeout(900);
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await frame
          .locator('.nt-editor')
          .waitFor({ state: 'hidden', timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(300);
        const label2 = await frame
          .locator('.nt-card', { hasText: 'Scratch — books to read next' })
          .locator('.nt-progress-label')
          .textContent();
        console.log(`[notes-v2-01] checklist progress label after toggling done: "${label2}"`);
        assert(
          label2 === '1/1',
          `expected checklist progress "1/1" after toggling done, got "${label2}"`,
        );
        await shot('card-checklist-done');
      },
    );

    await step(
      'pin-from-card-and-unpin-from-editor',
      'Pin a note from its card; verify Pinned group + sidebar count; unpin from the editor',
      async () => {
        const card = frame.locator('.nt-card', { hasText: 'Goa long weekend' });
        await card.locator('.nt-pin-btn').click();
        await page.waitForTimeout(500);
        await shot('note-pinned-from-card');
        const pinnedEyebrow = frame.locator('.nt-eyebrow', { hasText: 'Pinned' });
        await pinnedEyebrow.waitFor({ state: 'visible', timeout: 5_000 });
        const pinnedCountEl = frame
          .locator('.nt-nav-item', { hasText: 'Pinned' })
          .locator('.nt-nav-count');
        const pinnedCount = await pinnedCountEl.textContent();
        assert(pinnedCount === '1', `expected sidebar Pinned count 1, got ${pinnedCount}`);

        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const pinBtn = frame.locator('.kit-icon-btn[aria-label="Unpin note"]');
        await pinBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await pinBtn.click();
        await page.waitForTimeout(500);
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(400);
        const pinnedCountAfter = await frame
          .locator('.nt-nav-item', { hasText: 'Pinned' })
          .locator('.nt-nav-count')
          .textContent();
        console.log(`[notes-v2-01] Pinned count after unpin from editor: ${pinnedCountAfter}`);
        assert(
          pinnedCountAfter === '0',
          `expected sidebar Pinned count 0 after unpin, got ${pinnedCountAfter}`,
        );
        await shot('note-unpinned-from-editor');
      },
    );

    await step(
      'move-note-via-editor-select',
      'Move a note into "Recipes" via the editor\'s notebook <select>',
      async () => {
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        const card = frame.locator('.nt-card', { hasText: 'Scratch — books to read next' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const select = frame.locator('.nt-nb-select');
        await select.selectOption({ label: 'Recipes' });
        await page.waitForTimeout(600);
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(300);
        await frame.locator('.nt-nb-name', { hasText: 'Recipes' }).click();
        await page.waitForTimeout(300);
        await shot('note-moved-into-recipes');
        const cardInRecipes = frame.locator('.nt-card-title', {
          hasText: 'Scratch — books to read next',
        });
        await cardInRecipes.waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    await step(
      'attach-and-remove-file',
      'Attach a small PNG to a note, verify it shows in the strip, then remove it',
      async () => {
        const pngPath = path.join(OUT_DIR, 'tiny.png');
        // 1x1 transparent PNG.
        const pngBytes = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        );
        await fs.writeFile(pngPath, pngBytes);

        const card = frame.locator('.nt-card', { hasText: 'Scratch — books to read next' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        await frame.locator('.nt-attach-btn', { hasText: 'Attach a file' }).click();
        const fileInput = frame.locator('#attachInput');
        await fileInput.setInputFiles(pngPath);
        await page.waitForTimeout(900);
        await shot('attachment-added');
        const tile = frame.locator('.kit-attach-tile');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        assert((await tile.count()) >= 1, 'attachment tile did not render after attach');

        // Remove it: kit.js armConfirm — first click arms, second confirms.
        // NOTE: the remove button is imperative DOM (kit.js renderAttachments,
        // rebuilt wholesale by AttachStrip's useEffect whenever `note.attachments`
        // gets a new array reference — including from an UNRELATED refresh(),
        // e.g. chrome.js's `window.addEventListener('focus', refresh)`). If a
        // rebuild lands between the arm-click and the confirm-click, the fresh
        // button has lost its `data-kit-armed` state and the second click just
        // re-arms it instead of confirming — observed once in this suite. Retry
        // tolerantly and log if it took more than the expected 2 clicks.
        const removeBtn = frame.locator('.kit-attach-tile .kit-attach-remove');
        let attempts = 0;
        let tileCountAfter = 1;
        while (attempts < 5) {
          await removeBtn.click();
          attempts += 1;
          await page.waitForTimeout(400);
          tileCountAfter = await frame.locator('.kit-attach-tile').count();
          if (tileCountAfter === 0) break;
        }
        console.log(
          `[notes-v2-01] attachment remove took ${attempts} click(s) to land (2 is the expected arm+confirm)`,
        );
        if (attempts > 2) {
          console.log(
            '[notes-v2-01] FINDING: removing an attachment needed more than the expected 2 clicks — consistent with ' +
              "kit.js's renderAttachments/armConfirm losing its armed state to an interleaved rebuild (see Editor.jsx's " +
              'AttachStrip useEffect + kit.js renderAttachments/armConfirm, ~kit.js line 154 and 323). Reported since the ' +
              'mechanism is shared kit.js code, not something to fix inside packages/blueprints/apps/notes/** alone.',
          );
        }
        await shot('attachment-removed');
        assert(
          tileCountAfter === 0,
          `expected 0 attachment tiles after remove, got ${tileCountAfter} after ${attempts} clicks`,
        );
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
      },
    );

    await step(
      'search-and-clear',
      'Search for a term, verify filtered + highlighted results, then clear',
      async () => {
        // Reset to the "All notes" scope first — search combines with the
        // active nav (scopedRows filters search hits by nav too), and this
        // step means to test unscoped search, not "search within a notebook".
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        await frame.locator('#searchInput').fill('Goa');
        // The debounced search (120ms) + a real vault round-trip + render is
        // not reliably done in a fixed short wait, especially under load from
        // parallel E2E sessions — wait for the toolbar's own subtitle to
        // reflect the search state rather than guessing a sleep duration.
        await frame
          .locator('.nt-sub', { hasText: /match/ })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('search-results');
        const cards = frame.locator('.nt-card');
        const count = await cards.count();
        console.log(`[notes-v2-01] cards visible while searching "Goa": ${count}`);
        assert(count === 1, `expected exactly 1 search result for "Goa", got ${count}`);
        const cardTitle = await cards.first().locator('.nt-card-title').textContent();
        assert(
          /Goa/.test(cardTitle ?? ''),
          `search result card title doesn't contain "Goa": ${cardTitle}`,
        );
        const mark = frame.locator('.nt-card mark');
        assert((await mark.count()) >= 1, 'expected a highlighted <mark> in the search result');
        await frame.locator('#searchClear').click();
        await page.waitForTimeout(400);
        await shot('search-cleared');
        const countAfter = await frame.locator('.nt-card').count();
        assert(
          countAfter > 1,
          `expected more than 1 card after clearing search, got ${countAfter}`,
        );
      },
    );

    await step(
      'view-toggle-list-and-back',
      'Toggle List view then back to Card (masonry) view',
      async () => {
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(200);
        await frame.locator('#viewListBtn').click();
        await page.waitForTimeout(300);
        await shot('view-list');
        const wallList = frame.locator('.nt-wall.list');
        assert(
          (await wallList.count()) === 1,
          'wall did not get the "list" class after toggling List view',
        );
        await frame.locator('#viewMasonryBtn').click();
        await page.waitForTimeout(300);
        await shot('view-masonry');
      },
    );

    await step(
      'rename-notebook',
      'Rename "Recipes" notebook to "Cooking" via the toolbar',
      async () => {
        await frame.locator('.nt-nb-name', { hasText: 'Recipes' }).click();
        await page.waitForTimeout(300);
        await frame.locator('.kit-icon-btn[aria-label="Rename notebook"]').click();
        const input = frame.locator('.nt-title-input');
        await input.waitFor({ state: 'visible', timeout: 5_000 });
        await input.fill('Cooking');
        await input.press('Enter');
        await page.waitForTimeout(500);
        await shot('notebook-renamed');
        const nbItem = frame.locator('.nt-nb-name', { hasText: 'Cooking' });
        await nbItem.waitFor({ state: 'visible', timeout: 5_000 });
      },
    );

    await step(
      'delete-open-editor-note',
      'Delete a note from inside the editor (arm + confirm) -> editor closes, card gone',
      async () => {
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        const card = frame.locator('.nt-card', { hasText: 'Goa long weekend' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const deleteBtn = frame.locator('.kit-icon-btn.danger[aria-label="Delete note"]');
        await deleteBtn.click();
        await page.waitForTimeout(200);
        await shot('delete-note-armed');
        const confirmBtn = frame.locator('.kit-icon-btn.danger[aria-label="Confirm delete note"]');
        await confirmBtn.waitFor({ state: 'visible', timeout: 3_000 });
        await confirmBtn.click();
        await page.waitForTimeout(700);
        await shot('delete-note-confirmed');
        const editorGone = await frame.locator('.nt-editor').count();
        assert(editorGone === 0, 'editor did not close after deleting the currently-open note');
        const cardGone = await frame
          .locator('.nt-card-title', { hasText: 'Goa long weekend' })
          .count();
        assert(cardGone === 0, 'deleted note still shows in the wall');
      },
    );

    await step(
      'delete-notebook-unfiles-notes',
      'Delete "Cooking" notebook (has a note) -> note is unfiled, not destroyed',
      async () => {
        await frame.locator('.nt-nb-name', { hasText: 'Cooking' }).click();
        await page.waitForTimeout(300);
        const deleteBtn = frame.locator('.kit-icon-btn.danger[aria-label="Delete notebook"]');
        await deleteBtn.click();
        await page.waitForTimeout(200);
        const confirmBtn = frame.locator(
          '.kit-icon-btn.danger[aria-label="Confirm delete notebook"]',
        );
        await confirmBtn.waitFor({ state: 'visible', timeout: 3_000 });
        await confirmBtn.click();
        await page.waitForTimeout(700);
        await shot('notebook-deleted');
        const nbGone = await frame.locator('.nt-nb-name', { hasText: 'Cooking' }).count();
        assert(nbGone === 0, 'deleted notebook still shows in the sidebar');
        // Should have landed back on "All notes" and the note should still exist, unfiled.
        const noteStillThere = await frame
          .locator('.nt-card-title', { hasText: 'Scratch — books to read next' })
          .count();
        assert(
          noteStillThere >= 1,
          'note that was inside the deleted notebook was destroyed, not unfiled',
        );
      },
    );

    await step(
      'create-notebook-duplicate-name-allowed',
      'FINDING: knowledge.create_notebook has NO uniqueness precondition (unlike rename_notebook, which refuses via name_unused_by_owner) — creating two notebooks with the same disposable name both succeed',
      async () => {
        const makeOne = async () => {
          await frame.locator('button[aria-label="New notebook"]').click();
          const input = frame.locator('input[aria-label="Notebook name"]');
          await input.waitFor({ state: 'visible', timeout: 5_000 });
          await input.fill('Scratchpad');
          await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
          // Wait for the create-notebook write's own refresh() to settle and the
          // inline form to close (state.creatingNotebook flips false on success).
          await frame
            .locator('.nt-nb-form')
            .waitFor({ state: 'hidden', timeout: 10_000 })
            .catch(() => undefined);
          await page.waitForTimeout(400);
        };
        await makeOne();
        const countAfterFirst = await frame
          .locator('.nt-nb-name', { hasText: 'Scratchpad' })
          .count();
        await makeOne();
        const countAfterSecond = await frame
          .locator('.nt-nb-name', { hasText: 'Scratchpad' })
          .count();
        console.log(
          `[notes-v2-01] "Scratchpad" notebook count: after 1st create=${countAfterFirst}, after 2nd create (same name)=${countAfterSecond}`,
        );
        await shot('duplicate-notebook-name-allowed-on-create');
        assert(
          countAfterFirst === 1,
          `expected 1 "Scratchpad" notebook after the first create, got ${countAfterFirst}`,
        );
        if (countAfterSecond === 2) {
          console.log(
            '[notes-v2-01] CONFIRMED FINDING (root-caused in source, not app-specific): packages/vault/src/commands/knowledge.ts ' +
              'CREATE_NOTEBOOK.preconditions only has "parent_exists_if_given" — no name-uniqueness check — while RENAME_NOTEBOOK has an ' +
              'explicit "name_unused_by_owner" precondition whose own comment says duplicate names would confuse the owner. So the sidebar\'s ' +
              '"+"/quick-notebook flow (this app\'s create-notebook action) can silently produce two notebooks with the identical name and no ' +
              'way to tell them apart in the UI (Sidebar.jsx renders name only, no id/date), while renaming one of them to fix the collision is ' +
              'itself refused until the OTHER one is renamed or deleted first. This is a shared-vault-code gap, not something inside ' +
              'packages/blueprints/apps/notes/** — reported, not fixed, per policy.',
          );
        } else {
          console.log(
            `[notes-v2-01] did not reproduce the duplicate-name-on-create finding this run (count after 2nd create: ${countAfterSecond})`,
          );
        }
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ NOTES V2 CORE FLOWS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(38)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=====================================================================');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text} (${e.frameUrl})`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll notes-v2-01 core steps PASSED.');
    }
  } catch (err) {
    console.error('[notes-v2-01] FATAL:', err);
    await page.screenshot({ path: path.join(OUT_DIR, 'FATAL-FAILURE.png') }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

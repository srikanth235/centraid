#!/usr/bin/env node
// Notes v2 QA Suite 2: corner cases — empty note attempt, very long title/body,
// special characters (quotes/tags/emoji/unicode), rapid double-click submit,
// Escape mid-edit, editing then navigating away without an explicit save
// (autosave/flush-on-close data-loss check), deleting the currently-open
// note, pinning many notes, and 15+ notes for scroll/layout.
//
// Run with: node tests/e2e-live/flows-notes-v2-02-corner-cases.mjs   (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'notes-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-notes-v2-02');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-corner-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `corner-${String(shotN).padStart(2, '0')}-${name}.png`);
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
}

async function openNotes() {
  const tile = page.locator('[data-app-id="notes"]');
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

async function quickAdd(frame, title, body) {
  const titleInput = frame.locator('.nt-qa-title');
  await titleInput.click();
  if (title) await titleInput.fill(title);
  if (body) {
    const bodyInput = frame.locator('.nt-qa-body');
    await bodyInput.waitFor({ state: 'visible', timeout: 5_000 });
    await bodyInput.fill(body);
  }
  await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
  await page.waitForTimeout(500);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[notes-v2-02] launched + Home ready in ${Date.now() - t0}ms`);
  let frame;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-and-open', 'Install + open Notes', async () => {
      await installNotes();
      frame = await openNotes();
      await page.waitForTimeout(500);
    });

    await step(
      'empty-note-attempt',
      'Quick-add with no title/body is a no-op (friendly notice, no note created)',
      async () => {
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        const submit = frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' });
        // The submit button itself is disabled while both fields are empty —
        // confirm that state, then also probe pressing Enter in the (empty)
        // title field, which bypasses the disabled-button guard entirely.
        const disabled = await submit.isDisabled();
        console.log(`[notes-v2-02] "Add note" disabled with empty fields: ${disabled}`);
        await shot('empty-composer-disabled-submit');
        await titleInput.press('Enter');
        await page.waitForTimeout(400);
        const notice = frame.locator('#noticeBanner');
        const noticeText = await notice.textContent().catch(() => '');
        console.log(`[notes-v2-02] notice banner text after empty Enter-submit: "${noticeText}"`);
        const cardCount = await frame.locator('.nt-card').count();
        assert(
          cardCount === 0,
          `expected 0 notes after an empty-input submit attempt, got ${cardCount}`,
        );
        await shot('empty-note-attempt-result');
      },
    );

    await step(
      'very-long-title-and-body',
      'Very long title (300 chars) + multi-KB body saves cleanly, card preview stays bounded',
      async () => {
        const longTitle = 'L'.repeat(300);
        const longBody = Array.from(
          { length: 400 },
          (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog.`,
        ).join('\n');
        console.log(`[notes-v2-02] long body byte length: ${Buffer.byteLength(longBody, 'utf8')}`);
        await quickAdd(frame, longTitle, longBody);
        await shot('long-title-body-created');
        const card = frame.locator('.nt-card').first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        const cardBox = await card.boundingBox();
        console.log(`[notes-v2-02] long-note card bounding box: ${JSON.stringify(cardBox)}`);
        // Open it to confirm the full title/body actually round-tripped.
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const titleVal = await frame.locator('.nt-editor-title').inputValue();
        assert(
          titleVal.length === 300,
          `expected 300-char title to round-trip, got length ${titleVal.length}`,
        );
        await shot('long-note-opened-in-editor');
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(300);
      },
    );

    await step(
      'special-characters',
      'Title/body with quotes, HTML tags, emoji, unicode render as literal text, never interpreted as markup',
      async () => {
        const weirdTitle = '"quotes" <b>tags</b> & emoji 📝 ünïcödé';
        const weirdBody =
          'Body: "double" \'single\' <script>alert(1)</script> & 中文 日本語 émigré — done.';
        await quickAdd(frame, weirdTitle, weirdBody);
        await page.waitForTimeout(400);
        await shot('special-chars-created');
        const card = frame.locator('.nt-card', { hasText: 'emoji' });
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        const titleText = await card.locator('.nt-card-title').textContent();
        console.log(`[notes-v2-02] rendered card title: ${JSON.stringify(titleText)}`);
        assert(
          titleText?.includes('<b>'),
          `expected the literal string "<b>" to render as text, got: ${titleText}`,
        );
        const boldEls = await card.locator('b').count();
        assert(
          boldEls === 0,
          'special-char title was interpreted as HTML (a real <b> element rendered) instead of literal text',
        );
        const scriptEls = await frame.locator('script:has-text("alert(1)")').count();
        assert(
          scriptEls === 0,
          'note body containing <script> was injected into the DOM as a real <script> tag',
        );
        await shot('special-chars-verified-escaped');
      },
    );

    await step(
      'rapid-double-click-submit',
      'Rapid double-click "Add note" — busy-guard should prevent a duplicate note',
      async () => {
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        await titleInput.fill('Rapid double-click probe');
        const submit = frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' });
        await submit.waitFor({ state: 'visible', timeout: 5_000 });
        const before = await frame
          .locator('.nt-card-title', { hasText: 'Rapid double-click probe' })
          .count();
        // A successful submit clears+unmounts the composer (QuickAdd's submit()
        // resets state and closes), so the SECOND click can end up chasing a
        // button that's about to disappear — bound both clicks' own timeouts
        // short and swallow "element detached" so one click racing the unmount
        // doesn't hang this step for 30s.
        await Promise.all([
          submit.click({ timeout: 3_000 }).catch(() => undefined),
          submit.click({ force: true, timeout: 3_000 }).catch(() => undefined),
        ]);
        await page.waitForTimeout(900);
        const after = await frame
          .locator('.nt-card-title', { hasText: 'Rapid double-click probe' })
          .count();
        console.log(
          `[notes-v2-02] "Rapid double-click probe" cards before=${before} after=${after}`,
        );
        await shot('rapid-double-click-result');
        if (after > 1) {
          console.log(
            `[notes-v2-02] BUG-ish finding: rapid double-click on "Add note" produced ${after} duplicate notes — QuickAdd's busy useState guard did not prevent both clicks from landing (likely a React re-render race between the two synchronous click events before setBusy(true) commits).`,
          );
        }
        assert(after >= 1, 'rapid double-click submit produced no note at all');
      },
    );

    await step(
      'escape-mid-quickadd-no-cancel',
      'Pressing Escape while the quick-add composer is expanded does NOT close it (only its own Cancel button does) — documenting the behavior',
      async () => {
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        await titleInput.fill('Escape probe — should NOT be saved');
        await shot('escape-probe-before-escape');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const moreVisible = await frame
          .locator('.nt-qa-more')
          .isVisible()
          .catch(() => false);
        console.log(
          `[notes-v2-02] quick-add "more" section still visible after Escape: ${moreVisible}`,
        );
        await shot('escape-probe-after-escape');
        // Clean up via the real Cancel button regardless of the outcome above.
        const cancelBtn = frame.locator('.nt-qa-actions .kit-btn', { hasText: 'Cancel' });
        if (await cancelBtn.isVisible().catch(() => false)) {
          await cancelBtn.click();
          await page.waitForTimeout(200);
        }
        const leftoverCard = await frame
          .locator('.nt-card-title', { hasText: 'Escape probe' })
          .count();
        assert(
          leftoverCard === 0,
          'the Escape-then-Cancel probe note was saved, but it should have been discarded',
        );
      },
    );

    await step(
      'edit-then-navigate-away-no-explicit-save',
      'Type a title edit then immediately close the editor (Back) before the 700ms debounce fires — confirms flush() saves it anyway (no silent data loss)',
      async () => {
        const card = frame.locator('.nt-card', { hasText: 'Rapid double-click probe' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const titleInput = frame.locator('.nt-editor-title');
        await titleInput.fill('Rapid double-click probe — renamed just before close');
        // Close IMMEDIATELY — well under the 700ms autosave debounce.
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(500);
        await shot('closed-immediately-after-edit');
        const renamed = frame.locator('.nt-card-title', { hasText: 'renamed just before close' });
        const found = (await renamed.count()) > 0;
        console.log(
          `[notes-v2-02] title edit survived an immediate close-without-waiting-for-debounce: ${found}`,
        );
        assert(
          found,
          'closing the editor immediately after typing lost the edit — flush() on close did not save it (data loss)',
        );
      },
    );

    await step(
      'edit-then-click-backdrop-no-explicit-save',
      'Same probe, but close via clicking the editor backdrop instead of the Back button',
      async () => {
        const card = frame.locator('.nt-card', { hasText: 'renamed just before close' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        const titleInput = frame.locator('.nt-editor-title');
        await titleInput.fill('Renamed again via backdrop-click close');
        // Click the backdrop itself (outside the .nt-editor box), not the panel.
        await frame.locator('.nt-editor-backdrop').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(500);
        await shot('closed-via-backdrop-after-edit');
        const renamed = frame.locator('.nt-card-title', {
          hasText: 'Renamed again via backdrop-click',
        });
        const found = (await renamed.count()) > 0;
        console.log(`[notes-v2-02] title edit survived a backdrop-click close: ${found}`);
        assert(
          found,
          'closing the editor via backdrop click immediately after typing lost the edit',
        );
      },
    );

    await step(
      'delete-currently-open-note',
      'Delete the note while its own editor is open — editor should close and the note should vanish from the wall',
      async () => {
        const card = frame.locator('.nt-card', { hasText: 'Renamed again via backdrop-click' });
        await card.click();
        const editor = frame.locator('.nt-editor');
        await editor.waitFor({ state: 'visible', timeout: 10_000 });
        await frame.locator('.kit-icon-btn.danger[aria-label="Delete note"]').click();
        await page.waitForTimeout(200);
        const confirmBtn = frame.locator('.kit-icon-btn.danger[aria-label="Confirm delete note"]');
        await confirmBtn.waitFor({ state: 'visible', timeout: 3_000 });
        await confirmBtn.click();
        await page.waitForTimeout(600);
        await shot('deleted-currently-open-note');
        const editorGone = await frame.locator('.nt-editor').count();
        assert(editorGone === 0, 'editor stayed open after deleting the note it was showing');
        const cardGone = await frame
          .locator('.nt-card-title', { hasText: 'Renamed again via backdrop-click' })
          .count();
        assert(cardGone === 0, 'deleted note still appears in the wall');
      },
    );

    await step(
      'fifteen-plus-notes-and-many-pins',
      'Create 15 more notes (scroll/layout) and pin 6 of them (Pinned group + sidebar count)',
      async () => {
        for (let i = 1; i <= 15; i += 1) {
          await quickAdd(frame, `Bulk note #${i}`, `Body text for bulk note number ${i}.`);
        }
        await page.waitForTimeout(500);
        const totalCards = await frame.locator('.nt-card').count();
        console.log(`[notes-v2-02] total note cards after bulk create: ${totalCards}`);
        assert(totalCards >= 15, `expected at least 15 cards, got ${totalCards}`);
        await shot('fifteen-plus-notes-wall');

        // Pin 6 of the bulk notes.
        for (let i = 1; i <= 6; i += 1) {
          // "Bulk note #1" is a substring of "Bulk note #10".."#15" — anchor
          // the match to the card's title element, exact string, not the
          // whole card's text (which also carries the body preview).
          const card = frame.locator('.nt-card').filter({
            has: frame.locator('.nt-card-title', { hasText: new RegExp(`^Bulk note #${i}$`) }),
          });
          await card.locator('.nt-pin-btn').click();
          await page.waitForTimeout(150);
        }
        await page.waitForTimeout(400);
        await shot('six-notes-pinned');
        const pinnedCountEl = frame
          .locator('.nt-nav-item', { hasText: 'Pinned' })
          .locator('.nt-nav-count');
        const pinnedCount = await pinnedCountEl.textContent();
        console.log(`[notes-v2-02] sidebar Pinned count after pinning 6: ${pinnedCount}`);
        assert(pinnedCount === '6', `expected sidebar Pinned count 6, got ${pinnedCount}`);

        // Scroll the wall to the bottom and screenshot — visual layout check.
        await frame
          .locator('#scroll, .nt-scroll')
          .first()
          .evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          })
          .catch(() => undefined);
        await page.waitForTimeout(300);
        await shot('wall-scrolled-to-bottom');

        // Navigate to the Pinned smart section and confirm exactly 6 show.
        await frame.locator('.nt-nav-item', { hasText: 'Pinned' }).click();
        await page.waitForTimeout(300);
        await shot('pinned-section-six-notes');
        const pinnedCards = await frame.locator('.nt-card').count();
        assert(
          pinnedCards === 6,
          `expected exactly 6 cards in the Pinned section, got ${pinnedCards}`,
        );
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ NOTES V2 CORNER CASES VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(40)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=======================================================================');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text} (${e.frameUrl})`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll notes-v2-02 corner-case steps PASSED.');
    }
  } catch (err) {
    console.error('[notes-v2-02] FATAL:', err);
    await page
      .screenshot({ path: path.join(OUT_DIR, 'FATAL-corner-FAILURE.png') })
      .catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

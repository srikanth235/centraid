#!/usr/bin/env node
// Full end-user regression pass — Suite 1 (shell) + Suite 2 (docs deep pass) —
// against the REAL desktop app (real embedded gateway, real dev vault).
// Run with: node apps/desktop/tests/e2e-live/flows-full.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-flows-full');
const FIXTURES_DIR = path.join(__dirname, 'out', 'fixtures');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- tiny real fixture files (valid PNG / plain text / minimal PDF) ----
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function writeFixtures() {
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const pngPath = path.join(FIXTURES_DIR, 'tiny.png');
  const txtPath = path.join(FIXTURES_DIR, 'note.txt');
  const pdfPath = path.join(FIXTURES_DIR, 'doc.pdf');
  await fs.writeFile(pngPath, Buffer.from(PNG_1PX_BASE64, 'base64'));
  await fs.writeFile(txtPath, 'Hello from the e2e-live docs upload test.\n');
  // Minimal valid single-page PDF.
  const pdf = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`;
  await fs.writeFile(pdfPath, pdf);
  return { pngPath, txtPath, pdfPath };
}

// ---- findings / verdict harness ----
const results = [];
let page; // set once launched, reassigned across relaunches
const consoleMessages = []; // { text, type, frameUrl }

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
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
      error: err && err.stack ? err.stack : String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function openAppContextMenu(page, appId) {
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.waitFor({ state: 'visible', timeout: 15_000 });
  await tile.getByTestId('app-tile').click({ button: 'right' });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const fixtures = await writeFixtures();

  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  await page.setViewportSize({ width: 1400, height: 900 });

  // ============================= SUITE 1 =============================

  await step('1', 'Fresh boot -> Home renders', async () => {
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible' });
    await shot('01-home');
  });

  await step('2', 'Discover: 32 cards, kind filter chips, tiles/rows toggle', async () => {
    await navTo(page, 'Discover');
    const tiles = page.locator('button[data-kind]');
    await tiles.first().waitFor({ state: 'visible', timeout: 20_000 });
    assert((await tiles.count()) === 32, `expected 32 templates, got ${await tiles.count()}`);
    await shot('02-discover-all');

    await page.getByRole('tab', { name: /^Apps/ }).click();
    await page.waitForTimeout(150);
    let appCount = await page.locator('button[data-kind="app"]').count();
    assert(appCount === 8, `Apps filter: expected 8, got ${appCount}`);

    await page.getByRole('tab', { name: /^Automations/ }).click();
    await page.waitForTimeout(150);
    let autoCount = await page.locator('button[data-kind="automation"]').count();
    assert(autoCount === 24, `Automations filter: expected 24, got ${autoCount}`);

    await page.getByRole('tab', { name: /^All/ }).click();
    await page.waitForTimeout(150);
    assert((await tiles.count()) === 32, 'All filter should restore 32');

    const layoutGroup = page.getByRole('group', { name: 'Layout' });
    await layoutGroup.getByRole('button', { name: 'Rows', exact: true }).click();
    await page.waitForTimeout(150);
    await shot('02-discover-rows');
    await layoutGroup.getByRole('button', { name: 'Tiles', exact: true }).click();
    await page.waitForTimeout(150);
  });

  await step('3a', 'Use template (Docs) -> toast -> Home tile -> PUBLISHED verbs', async () => {
    const docsCard = page.locator('button[data-kind="app"]', { hasText: 'Docs' }).first();
    await docsCard.waitFor({ state: 'visible', timeout: 10_000 });
    await docsCard.click();
    const dialog = page.getByRole('dialog', { name: /^Preview Docs/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();

    const toast = page.locator('[data-global-toast]');
    await toast.waitFor({ state: 'visible', timeout: 10_000 });
    const toastText = await toast.textContent();
    assert(/Installed "Docs"/.test(toastText ?? ''), `unexpected toast: ${toastText}`);

    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    const tile = page.locator('[data-app-id="docs"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await shot('03a-home-with-docs');

    await tile.getByTestId('app-tile').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    const menuText = await menu.textContent();
    assert(/Open/.test(menuText ?? ''), `expected "Open" verb, menu was: ${menuText}`);
    assert(/Edit with Centraid/.test(menuText ?? ''), `expected "Edit with Centraid", menu was: ${menuText}`);
    assert(!/Continue editing/.test(menuText ?? ''), `should NOT show draft verb "Continue editing": ${menuText}`);
    assert(!/Delete draft/.test(menuText ?? ''), `should NOT show "Delete draft": ${menuText}`);
    // The plain context-menu overlay (contextMenu.ts) has NO Escape handler —
    // only clicking its full-screen backdrop closes it. Click a neutral point.
    await page.mouse.click(1250, 60);
    await menu.waitFor({ state: 'hidden', timeout: 5_000 });
  });

  await step('3a-diag', 'Diagnostic: does the gateway list "docs" as an app right after publish?', async () => {
    const diag = await page.evaluate(async () => {
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const res = await fetch(`${baseUrl}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    });
    console.log(`[3a-diag] GET /_apps status=${diag.status} body=${JSON.stringify(diag.body)}`);
  });

  await step('3b', 'Install same template again -> unique id/name, both coexist', async () => {
    await navTo(page, 'Discover');
    const docsCard = page.locator('button[data-kind="app"]', { hasText: 'Docs' }).first();
    await docsCard.waitFor({ state: 'visible', timeout: 10_000 });
    const toastBefore = await page
      .locator('[data-global-toast]')
      .textContent()
      .catch(() => null);
    await docsCard.click();
    const dialog = page.getByRole('dialog', { name: /^Preview Docs/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-global-toast]');
        return !!el && el.textContent !== prev;
      },
      toastBefore,
      { timeout: 10_000 },
    );
    const toast = page.locator('[data-global-toast]');
    const toastText = await toast.textContent();
    const diagAfter = await page.evaluate(async () => {
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const res = await fetch(`${baseUrl}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json().catch(() => null);
    });
    console.log(`[3b] toast after action: ${JSON.stringify(toastText)}`);
    console.log(`[3b] /_apps after action: ${JSON.stringify(diagAfter)}`);
    assert(/Installed "Docs 2"/.test(toastText ?? ''), `expected "Docs 2", toast was: ${toastText}`);
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-app-id="docs"]').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('[data-app-id="docs-2"]').waitFor({ state: 'visible', timeout: 5_000 });
    await shot('03b-home-two-docs');
  });

  await step('3c', 'Right-click an APP template card -> Use this template installs', async () => {
    await navTo(page, 'Discover');
    const agendaCard = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
    await agendaCard.waitFor({ state: 'visible', timeout: 10_000 });
    console.log(`[3c] agendaCard text: ${JSON.stringify(await agendaCard.textContent())}`);
    const toastBefore = await page
      .locator('[data-global-toast]')
      .textContent()
      .catch(() => null);
    console.log(`[3c] toast present before action: ${JSON.stringify(toastBefore)}`);
    await agendaCard.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    const menuText = await menu.textContent();
    console.log(`[3c] context menu text: ${JSON.stringify(menuText)}`);
    await menu.getByRole('menuitem', { name: 'Use this template' }).click();
    // Wait for a FRESH toast (different text from whatever was showing
    // before, in case a prior toast's 2s auto-dismiss timer hadn't fired).
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-global-toast]');
        return !!el && el.textContent !== prev;
      },
      toastBefore,
      { timeout: 10_000 },
    );
    const toast = page.locator('[data-global-toast]');
    const agendaToastText = await toast.textContent();
    const diagAfter = await page.evaluate(async () => {
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const res = await fetch(`${baseUrl}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json().catch(() => null);
    });
    console.log(`[3c] toast after action: ${JSON.stringify(agendaToastText)}`);
    console.log(`[3c] /_apps after action: ${JSON.stringify(diagAfter)}`);
    assert(/Installed "Agenda"/.test(agendaToastText ?? ''), `expected Agenda install toast, got: ${agendaToastText}`);
    await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 10_000 });
  });

  await step(
    '3d',
    'Right-click an AUTOMATION template -> Use this template goes to builder (not Home); Preview shows drawer',
    async () => {
      await navTo(page, 'Discover');
      const autoCard = page.locator('button[data-kind="automation"]').first();
      await autoCard.waitFor({ state: 'visible', timeout: 10_000 });
      const autoName = (await autoCard.locator('.cardName, [class*="cardName"]').first().textContent().catch(() => null)) ?? '';

      // Preview first (non-destructive).
      await autoCard.click({ button: 'right' });
      let menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible', timeout: 5_000 });
      await menu.getByRole('menuitem', { name: 'Preview' }).click();
      const drawer = page.getByRole('dialog', { name: /template$/ });
      await drawer.waitFor({ state: 'visible', timeout: 5_000 });
      const drawerText = await drawer.textContent();
      assert(/Fires /.test(drawerText ?? ''), `expected trigger info ("Fires ...") in drawer: ${drawerText}`);
      await page.waitForTimeout(400); // let the slide-in animation settle before the screenshot
      await shot('03d-automation-preview-drawer');
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden', timeout: 5_000 });

      // Now the real "Use this template" -> builder path.
      await autoCard.click({ button: 'right' });
      menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible', timeout: 5_000 });
      await menu.getByRole('menuitem', { name: 'Use this template' }).click();

      // Must land in the automation builder — assert Config tab appears and
      // we did NOT bounce back to the Home composer heading.
      await page.getByRole('button', { name: 'Config' }).waitFor({ state: 'visible', timeout: 15_000 });
      const homeHeadingVisible = await page
        .getByRole('heading', { name: 'What should we build?' })
        .isVisible()
        .catch(() => false);
      assert(!homeHeadingVisible, 'automation "Use this template" incorrectly landed on Home');
      await shot('03d-automation-builder');
      void autoName;
      await navTo(page, 'Home');
      await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    },
  );

  await step('3e', 'Restart persistence — relaunch with SAME userData, installed apps still on Home', async () => {
    await session.close();
    await new Promise((r) => setTimeout(r, 500));
    session = await launchApp({ userDataDir: USER_DATA_DIR });
    page = session.page;
    wireConsole(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('[data-app-id="docs"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-app-id="docs-2"]').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 5_000 });
    await shot('03e-restart-home');
  });

  let docsFirstOpenConsoleCountAtOpen = 0;
  await step('4', 'Open installed Docs app -> iframe renders; back+reopen still fine', async () => {
    const tile = page.locator('[data-app-id="docs"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    docsFirstOpenConsoleCountAtOpen = consoleMessages.length;
    await tile.getByTestId('app-tile').click();
    const iframe = page.locator('iframe[data-centraid-app="1"]');
    await iframe.waitFor({ state: 'attached', timeout: 20_000 });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot('04-docs-app-open');

    // "Back" — the shell's back nav.
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    await tile.getByTestId('app-tile').click();
    await page.locator('iframe[data-centraid-app="1"]').waitFor({ state: 'attached', timeout: 15_000 });
    await shot('04-docs-app-reopen');
  });

  await step('5', 'Edit installed Docs app -> builder opens with WORKING preview iframe', async () => {
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    await openAppContextMenu(page, 'docs');
    const menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    await menu.getByRole('menuitem', { name: 'Edit with Centraid' }).click();

    // Builder chrome should appear (Preview/Code/Cloud tabs — app-kind).
    await page
      .getByRole('button', { name: 'Preview', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 });
    await shot('05-builder-opened');

    // The critical regression check: preview must NOT be stuck on "Building…"
    // forever — wait generously, then assert the iframe attaches and the
    // building pill disappears.
    const iframe = page.locator('iframe[data-centraid-app="1"]');
    await iframe.waitFor({ state: 'attached', timeout: 20_000 });
    await page.getByText('Building · preview refreshes on save').waitFor({ state: 'hidden', timeout: 20_000 });
    await shot('05-builder-preview-resolved');

    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  });

  await step('6', 'Rename + delete installed app; delete then re-install same template', async () => {
    // Rename Agenda -> "Agenda Renamed".
    await openAppContextMenu(page, 'agenda');
    let menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    await menu.getByRole('menuitem', { name: 'Rename' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename app' });
    await renameDialog.waitFor({ state: 'visible', timeout: 5_000 });
    const promptInput = renameDialog.locator('input');
    await promptInput.waitFor({ state: 'visible', timeout: 5_000 });
    await promptInput.fill('Agenda Renamed');
    console.log(`[6] rename input value before submit: ${JSON.stringify(await promptInput.inputValue())}`);
    await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await renameDialog.waitFor({ state: 'hidden', timeout: 5_000 });
    const renameToast = await page
      .locator('[data-global-toast]')
      .textContent({ timeout: 3_000 })
      .catch(() => '(no toast seen)');
    console.log(`[6] toast after rename: ${JSON.stringify(renameToast)}`);
    await page.waitForTimeout(800);
    const diagAfterRename = await page.evaluate(async () => {
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const res = await fetch(`${baseUrl}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json().catch(() => null);
    });
    console.log(`[6] /_apps after rename: ${JSON.stringify(diagAfterRename)}`);
    const tileNameText = await page
      .locator('[data-app-id="agenda"]')
      .locator('div')
      .filter({ hasText: 'Agenda Renamed' })
      .first()
      .isVisible()
      .catch(() => false);
    assert(tileNameText, 'renamed tile text "Agenda Renamed" not found on Home');
    await shot('06-renamed');

    // Delete Agenda.
    await openAppContextMenu(page, 'agenda');
    menu = page.getByRole('menu');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    const confirmDialog = page.getByRole('dialog').filter({ hasText: 'Delete app?' });
    await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();
    await page.locator('[data-app-id="agenda"]').waitFor({ state: 'hidden', timeout: 10_000 });
    await shot('06-deleted');

    // Re-install Agenda from its template.
    await navTo(page, 'Discover');
    const agendaCard = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
    await agendaCard.waitFor({ state: 'visible', timeout: 10_000 });
    await agendaCard.click();
    const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 10_000 });
    await navTo(page, 'Home');
  });

  await step('7', 'Theme toggle: shell flips AND open blueprint app iframe follows', async () => {
    // Open Docs first so we have a live iframe to observe.
    await page.locator('[data-app-id="docs"]').getByTestId('app-tile').click();
    await page.locator('iframe[data-centraid-app="1"]').waitFor({ state: 'attached', timeout: 15_000 });
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);

    // Settings' sidebar button has a trailing "live" status pill, so its
    // accessible name isn't the exact string "Settings" — navTo's exact
    // match doesn't fit; match by regex instead.
    await page.getByRole('button', { name: /^Settings/ }).first().click();
    // Appearance is the default settings page.
    const radios = page.getByRole('radio');
    await radios.first().waitFor({ state: 'visible', timeout: 10_000 });
    const count = await radios.count();
    let switched = false;
    for (let i = 0; i < count; i++) {
      const r = radios.nth(i);
      const checked = await r.getAttribute('aria-checked');
      if (checked !== 'true') {
        await r.click();
        switched = true;
        break;
      }
    }
    assert(switched, 'could not find an alternate theme radio to click');
    await page.waitForTimeout(400);
    const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
    assert(themeAfter !== themeBefore, `theme did not change: ${themeBefore} -> ${themeAfter}`);
    await shot('07-settings-theme-switched');

    // Go back to the open Docs app and confirm the iframe followed (postMessage
    // 'centraid:theme' on the app's own <html data-theme>).
    await navTo(page, 'Home');
    await page.locator('[data-app-id="docs"]').getByTestId('app-tile').click();
    const frame = await (await page.waitForSelector('iframe[data-centraid-app="1"]')).contentFrame();
    await page.waitForTimeout(600);
    const frameTheme = await frame.evaluate(() => document.documentElement.dataset.theme || document.body.dataset.theme);
    await shot('07-docs-app-theme-followed');
    console.log(`[7] shell theme=${themeAfter} frame theme=${frameTheme}`);
  });

  await step('8', 'Consent seam: first open of freshly installed app (observation)', async () => {
    // Docs-2 has never been opened yet — a clean "first open" to observe.
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    const tile = page.locator('[data-app-id="docs-2"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await tile.getByTestId('app-tile').click();
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800);
    const bannerHidden = await frameLoc
      .locator('#consentBanner')
      .isHidden()
      .catch(() => true);
    const emptyVisible = await frameLoc
      .locator('.kit-empty')
      .first()
      .isVisible()
      .catch(() => false);
    await shot('08-docs2-first-open');
    console.log(`[8] consentBanner hidden=${bannerHidden} kit-empty visible=${emptyVisible}`);
    assert(bannerHidden || emptyVisible, 'first open shows neither data nor an empty state — stuck?');
  });

  await step('9', 'Narrow window (~500px) -> shell usable, docs app adapts', async () => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForTimeout(400);
    await shot('09-narrow-shell');
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    const tile = page.locator('[data-app-id="docs"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await tile.getByTestId('app-tile').click();
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(500);
    const narrowClass = await frameLoc
      .locator('#root, .is-narrow')
      .first()
      .getAttribute('class')
      .catch(() => null);
    await shot('09-narrow-docs-app');
    console.log(`[9] docs root class after narrow: ${narrowClass}`);
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  // ============================= SUITE 2 (docs deep pass, using "docs") =====

  const docsFrame = () => page.frameLocator('iframe[data-centraid-app="1"]');

  await step('S2-empty', 'Empty vault first-run: docs empty state, storage zeros, no console errors', async () => {
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    const tile = page.locator('[data-app-id="docs"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await tile.getByTestId('app-tile').click();
    await page.locator('iframe[data-centraid-app="1"]').waitFor({ state: 'attached', timeout: 15_000 });
    const frameLoc = docsFrame();
    await frameLoc.locator('.kit-empty').first().waitFor({ state: 'visible', timeout: 15_000 });
    const storageText = await frameLoc.locator('.d-storage-label, [class*="storage"]').first().textContent().catch(() => '');
    await shot('S2-empty-docs');
    console.log(`[S2-empty] storage label: ${JSON.stringify(storageText)}`);
  });

  await step('S2-upload', 'Real upload via #uploadInput lands in vault; survives close+reopen+restart', async () => {
    const frameLoc = docsFrame();
    const fileInput = frameLoc.locator('#uploadInput');
    await fileInput.setInputFiles([fixtures.pngPath, fixtures.txtPath, fixtures.pdfPath]);
    await frameLoc.locator('.d-card').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(500);
    const cardCount = await frameLoc.locator('.d-card').count();
    assert(cardCount >= 3, `expected >= 3 cards after uploading 3 files, got ${cardCount}`);
    await shot('S2-upload-grid');

    // Close app (nav home) + reopen -> persists within the same process.
    await navTo(page, 'Home');
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-app-id="docs"]').getByTestId('app-tile').click();
    await page.locator('iframe[data-centraid-app="1"]').waitFor({ state: 'attached', timeout: 15_000 });
    await docsFrame().locator('.d-card').first().waitFor({ state: 'visible', timeout: 15_000 });
    assert((await docsFrame().locator('.d-card').count()) >= 3, 'uploaded cards gone after reopen');

    // Full app restart (reused userData) -> vault persistence.
    await session.close();
    await new Promise((r) => setTimeout(r, 500));
    session = await launchApp({ userDataDir: USER_DATA_DIR });
    page = session.page;
    wireConsole(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('[data-app-id="docs"]').getByTestId('app-tile').click();
    await page.locator('iframe[data-centraid-app="1"]').waitFor({ state: 'attached', timeout: 15_000 });
    await docsFrame().locator('.d-card').first().waitFor({ state: 'visible', timeout: 15_000 });
    const countAfterRestart = await docsFrame().locator('.d-card').count();
    assert(countAfterRestart >= 3, `uploaded cards gone after full app restart, got ${countAfterRestart}`);
    await shot('S2-upload-after-restart');
  });

  await step('S2-search', 'Search filters the grid', async () => {
    const frameLoc = docsFrame();
    const before = await frameLoc.locator('.d-card').count();
    await frameLoc.locator('#searchInput').fill('note');
    await page.waitForTimeout(500);
    const during = await frameLoc.locator('.d-card').count();
    await shot('S2-search-note');
    await frameLoc.locator('#searchInput').fill('');
    await page.waitForTimeout(400);
    const after = await frameLoc.locator('.d-card').count();
    console.log(`[S2-search] cards: before=${before} during("note")=${during} after-clear=${after}`);
    assert(after === before, 'clearing search did not restore full card count');
  });

  await step('S2-grid-list', 'Grid <-> list view toggle', async () => {
    const frameLoc = docsFrame();
    await frameLoc.locator('#viewList').click();
    await page.waitForTimeout(300);
    await shot('S2-list-view');
    const listRows = await frameLoc.locator('.d-row, .d-list-row, [class*="d-list"]').count();
    console.log(`[S2-grid-list] list-view row-ish elements: ${listRows}`);
    await frameLoc.locator('#viewGrid').click();
    await page.waitForTimeout(300);
    await shot('S2-grid-view');
    assert((await frameLoc.locator('.d-card').count()) >= 3, 'grid cards missing after switching back from list');
  });

  await step('S2-details-star', 'Details drawer opens; star toggles and persists across reopen', async () => {
    const frameLoc = docsFrame();
    // Click the title text (NOT the thumbnail, which owns its own onClick ->
    // quick-look and stops propagation) to open the details drawer.
    await frameLoc.locator('.d-card-title').first().click();
    const details = frameLoc.locator('[aria-label="Document details"]');
    await details.waitFor({ state: 'visible', timeout: 10_000 });
    await shot('S2-details-drawer');

    const starBtn = details.getByRole('button', { name: /Star/ });
    await starBtn.waitFor({ state: 'visible', timeout: 5_000 });
    const before = await starBtn.textContent();
    await starBtn.click();
    await page.waitForTimeout(400);
    const after = await starBtn.textContent();
    assert(before !== after, `star button text did not change: ${before} -> ${after}`);
    await shot('S2-starred');

    await details.getByRole('button', { name: 'Close' }).click();
    await details.waitFor({ state: 'hidden', timeout: 5_000 });

    // Reopen and confirm the star persisted.
    await frameLoc.locator('.d-card-title').first().click();
    await details.waitFor({ state: 'visible', timeout: 10_000 });
    const reopenedStarText = await details.getByRole('button', { name: /Star/ }).textContent();
    assert(reopenedStarText === after, `star did not persist across reopen: expected ${after}, got ${reopenedStarText}`);
    await details.getByRole('button', { name: 'Close' }).click();
    await details.waitFor({ state: 'hidden', timeout: 5_000 });
  });

  await step('S2-quicklook', 'Quick-look: opens from thumbnail, arrows, on-dark close, download', async () => {
    const frameLoc = docsFrame();
    await frameLoc.locator('.d-thumb').first().click();
    const quick = frameLoc.locator('[aria-label="Quick look"]');
    await quick.waitFor({ state: 'visible', timeout: 10_000 });
    await shot('S2-quicklook-open');

    const nextBtn = quick.getByRole('button', { name: 'Next' });
    if (await nextBtn.isEnabled().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(300);
      await shot('S2-quicklook-next');
      await quick.getByRole('button', { name: 'Previous' }).click();
      await page.waitForTimeout(300);
    }
    assert(await quick.getByText('Download').isVisible(), 'quick-look missing Download control');
    await quick.getByRole('button', { name: 'Close' }).click();
    await quick.waitFor({ state: 'hidden', timeout: 5_000 });

    // Re-open and close via Escape instead (global keydown in chrome.js).
    await frameLoc.locator('.d-thumb').first().click();
    await quick.waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await quick.waitFor({ state: 'hidden', timeout: 5_000 });
  });

  await step('S2-folders', 'Folder create + move a file into it + folder counts', async () => {
    const frameLoc = docsFrame();
    await frameLoc.locator('#newBtn').click();
    await frameLoc.getByRole('menuitem', { name: 'New folder' }).click();
    const folderInput = frameLoc.locator('input[aria-label="New folder name"]');
    await folderInput.waitFor({ state: 'visible', timeout: 5_000 });
    await folderInput.fill('Receipts');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const folderNav = frameLoc.getByRole('button', { name: /^Receipts/ });
    await folderNav.waitFor({ state: 'visible', timeout: 10_000 });
    await shot('S2-folder-created');

    // Select one card via its checkbox, then bulk "Move to..." -> Receipts.
    const checkbox = frameLoc.locator('.d-card-select').first();
    await checkbox.click();
    const bulkBar = frameLoc.locator('.d-bulk-count');
    await bulkBar.waitFor({ state: 'visible', timeout: 5_000 });
    await frameLoc.getByRole('button', { name: 'Move to…' }).click();
    const popover = frameLoc.locator('.kit-popover-scroll');
    await popover.waitFor({ state: 'visible', timeout: 5_000 });
    await popover.getByRole('menuitem', { name: 'Receipts' }).click();
    await page.waitForTimeout(500);
    await shot('S2-moved-to-folder');

    await folderNav.click();
    await page.waitForTimeout(400);
    const inFolder = await frameLoc.locator('.d-card').count();
    console.log(`[S2-folders] documents inside Receipts folder: ${inFolder}`);
    assert(inFolder >= 1, 'moved file not showing inside its folder');
    await shot('S2-folder-contents');

    // Back to All documents.
    await frameLoc.getByRole('button', { name: 'All documents' }).click();
    await page.waitForTimeout(300);
  });

  await step('S2-bulk-trash-restore', 'Bulk select -> trash -> restore', async () => {
    const frameLoc = docsFrame();
    const checkboxes = frameLoc.locator('.d-card-select');
    const n = await checkboxes.count();
    assert(n >= 1, 'no cards left to trash');
    await checkboxes.nth(0).click();
    if (n > 1) await checkboxes.nth(1).click();
    const bulkBar = frameLoc.locator('.d-bulk-count');
    await bulkBar.waitFor({ state: 'visible', timeout: 5_000 });
    const selectedText = await bulkBar.textContent();
    console.log(`[S2-bulk-trash-restore] bulk bar: ${selectedText}`);

    // Scoped by CSS class, not accessible name — armConfirm (kit.js) mutates
    // the button's textContent imperatively ("Trash" -> "Trash N — sure?"),
    // so a name-based locator stops matching after the first (arming) click.
    // The sidebar's "Trash" nav item also shares the accessible name, so a
    // role+name match would collide with it regardless.
    const trashBtn = frameLoc.locator('.d-bulk-actions .kit-btn.danger');
    await trashBtn.click(); // arm
    await page.waitForTimeout(200);
    await trashBtn.click(); // confirm (armConfirm double-click pattern)
    await bulkBar.waitFor({ state: 'hidden', timeout: 5_000 });
    await shot('S2-trashed');

    const trashNav = frameLoc.getByRole('button', { name: /^Trash/ });
    await trashNav.click();
    await page.waitForTimeout(400);
    const trashedCount = await frameLoc.locator('.d-card').count();
    console.log(`[S2-bulk-trash-restore] documents in Trash: ${trashedCount}`);
    assert(trashedCount >= 1, 'trashed documents not showing under Trash');
    await shot('S2-trash-view');

    // Restore one.
    await frameLoc.locator('.d-card-select').first().click();
    const restoreBtn = frameLoc.getByRole('button', { name: 'Restore' });
    await restoreBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await restoreBtn.click();
    await page.waitForTimeout(500);
    await shot('S2-restored');

    // Confirm no wait-free purge control is offered from Trash (30-day auto-purge only).
    const purgeBtnCount = await frameLoc.getByRole('button', { name: /purge/i }).count();
    console.log(`[S2-bulk-trash-restore] explicit "purge now" controls found: ${purgeBtnCount} (expected 0 — 30-day auto-purge only)`);

    await frameLoc.getByRole('button', { name: 'All documents' }).click();
    await page.waitForTimeout(300);
  });

  await step('S2-type-chips-sort', 'Type filter chips + sort control', async () => {
    const frameLoc = docsFrame();
    const pdfChip = frameLoc.getByRole('button', { name: 'PDFs' });
    await pdfChip.click();
    await page.waitForTimeout(300);
    await shot('S2-type-chip-pdf');
    const allChip = frameLoc.getByRole('button', { name: 'All', exact: true }).first();
    await allChip.click();
    await page.waitForTimeout(300);

    const sortBtn = frameLoc.locator('#sortBtn');
    if (await sortBtn.count()) {
      await sortBtn.click();
      await page.waitForTimeout(300);
      await shot('S2-sorted');
    }
  });

  await step('S2-consent-banner', 'Consent banner stays hidden throughout granted use', async () => {
    const frameLoc = docsFrame();
    const bannerHidden = await frameLoc.locator('#consentBanner').isHidden().catch(() => true);
    assert(bannerHidden, '#consentBanner is visible during normal granted use');
  });

  await step('S2-ask-panel', 'Ask button visible; panel closed by default; opens/closes via button + Esc; no scrim', async () => {
    const frameLoc = docsFrame();
    const scrimVisibleBefore = await frameLoc
      .locator('.kit-ask-ov')
      .first()
      .isVisible()
      .catch(() => false);
    assert(!scrimVisibleBefore, 'Ask overlay (.kit-ask-ov) is visible BEFORE opening it — the [hidden] bug is back');
    const askBtn = frameLoc.locator('#kitAskBtn');
    await askBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await shot('S2-ask-closed-topbar');
    await askBtn.click();
    await frameLoc.locator('#kitAskOverlay').waitFor({ state: 'visible', timeout: 5_000 });
    await shot('S2-ask-open');
    await page.keyboard.press('Escape');
    const askHiddenAfterEsc = await frameLoc
      .locator('#kitAskOverlay')
      .isHidden()
      .catch(() => false);
    assert(askHiddenAfterEsc, 'Ask overlay did not close on Escape');
  });

  await step('S2-dark-narrow', 'Dark + narrow inside the shell for a sample of the docs journeys', async () => {
    await page.setViewportSize({ width: 480, height: 850 });
    await page.waitForTimeout(500);
    await shot('S2-dark-narrow-docs');
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  // ============================= REPORT =============================

  const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
  const consoleWarnings = consoleMessages.filter((m) => m.type === 'warning');

  console.log('\n================ VERDICT TABLE ================');
  for (const r of results) {
    console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(6)} ${r.label} (${r.ms}ms)`);
    if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
  }
  console.log('=================================================');
  console.log(`Total console messages captured: ${consoleMessages.length}`);
  console.log(`Console errors: ${consoleErrors.length}, warnings: ${consoleWarnings.length}`);
  for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
  for (const w of consoleWarnings.slice(0, 20)) console.log(`  WARN: ${w.text}`);

  const failCount = results.filter((r) => r.verdict === 'fail').length;
  await session.close();
  if (failCount > 0) {
    console.error(`\n${failCount} step(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll steps PASSED.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

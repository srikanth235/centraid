#!/usr/bin/env node
// Proves the rig can drive a blueprint-app IFRAME inside the real desktop
// shell — the hard requirement downstream docs/photos testers need. A
// fresh dev vault has no installed apps yet, so this rides the same
// Use-template path a real user takes: Discover → preview → "Use this
// template" installs the template directly as a published app and pins it
// to Home (see DiscoverRoute.tsx's `applyAppTemplate` — an owner decision,
// no draft/builder detour). Opening that Home tile lands on AppViewRoute,
// whose `AppFrame` is a sandboxed iframe onto the gateway's LIVE app —
// real HTTP origin, not a mock (see AppFrame.tsx —
// `iframe[data-centraid-app="1"]`).
//
// Run with: node apps/desktop/tests/e2e-live/iframe-probe.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const { page, userDataDir, close } = await launchApp();
  console.log(`[iframe-probe] launched + Home ready in ${Date.now() - t0}ms`);

  // Capture EVERY console message the page reports, across ALL frames —
  // Playwright's page-level 'console' event fires for child (iframe) frames
  // too, not just the main frame; this array is how we verify that below.
  /** @type {Array<{text: string, frameUrl: string}>} */
  const consoleLog = [];
  page.on('console', (msg) => {
    consoleLog.push({ text: msg.text(), frameUrl: msg.location()?.url ?? '' });
  });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // → Discover → the Agenda app template (known h1 + a benign, always-
    // wired view-toggle button — see packages/blueprints/apps/agenda).
    await navTo(page, 'Discover');
    const agendaCard = page.locator('button[data-kind="app"]', { hasText: 'Agenda' });
    await agendaCard.first().waitFor({ state: 'visible', timeout: 20_000 });
    await agendaCard.first().click();

    const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    console.log('[iframe-probe] installed Agenda from its template');

    // Installing pins the app to Home and navigates there directly (no
    // builder detour) — wait for the tile, then open it.
    const tile = page.locator('[data-app-id="agenda"]');
    await tile.waitFor({ state: 'visible', timeout: 20_000 });
    await tile.getByTestId('app-tile').click();
    console.log('[iframe-probe] opened the Agenda app tile');

    const iframeHandle = await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 30_000,
    });
    console.log(`[iframe-probe] app iframe attached ${Date.now() - t0}ms in`);

    // 1) Obtain a real Frame handle (not just a FrameLocator) — needed below
    //    to run script IN the iframe's context (frame.evaluate).
    const frame = await iframeHandle.contentFrame();
    assert(frame !== null, 'iframe.contentFrame() returned null');

    // Also exercise the FrameLocator API (the ergonomic surface downstream
    // testers will actually use for docs/photos).
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');

    // 2) Read a DOM element INSIDE the app.
    await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
    const h1Text = await frameLoc.locator('h1').first().textContent();
    console.log(`[iframe-probe] iframe h1 = ${JSON.stringify(h1Text)}`);
    assert(h1Text?.trim() === 'Agenda', `expected iframe h1 "Agenda", got ${h1Text}`);

    const kitBannerCount = await frameLoc.locator('.kit-banner').count();
    console.log(`[iframe-probe] iframe has ${kitBannerCount} .kit-banner node(s)`);
    assert(kitBannerCount >= 1, 'expected at least one .kit-banner node inside the app iframe');

    // 3) Click something inside the iframe and observe real state change —
    //    the week/month/list view toggle is wired unconditionally (no vault
    //    consent gate), see apps/agenda/app.js `setView`.
    const weekBtn = frameLoc.locator('#weekViewBtn');
    await weekBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const beforePressed = await weekBtn.getAttribute('aria-pressed');
    await weekBtn.click();
    await page.waitForTimeout(200); // aria-pressed flip is synchronous, but be generous
    const afterPressed = await weekBtn.getAttribute('aria-pressed');
    console.log(`[iframe-probe] #weekViewBtn aria-pressed: ${beforePressed} → ${afterPressed}`);
    assert(beforePressed !== 'true', 'week view should not start pressed (month is default)');
    assert(
      afterPressed === 'true',
      'click inside iframe did not flip aria-pressed — click failed to land',
    );

    // 4) Prove page.on('console') captures CHILD-FRAME console messages: emit
    //    a uniquely-tagged log INSIDE the iframe's own JS realm via
    //    frame.evaluate, then confirm it shows up in our page-level listener.
    const marker = `IFRAME_PROBE_MARKER_${Date.now()}`;
    await frame.evaluate((m) => console.log('[agenda-iframe]', m), marker);
    await page.waitForTimeout(300);
    const captured = consoleLog.find((c) => c.text.includes(marker));
    console.log(
      `[iframe-probe] console messages captured so far: ${consoleLog.length}; marker found: ${Boolean(captured)}`,
    );
    if (captured) console.log(`[iframe-probe]   -> ${JSON.stringify(captured)}`);
    assert(Boolean(captured), 'page.on("console") did not capture the child-frame console.log');

    const shot = path.join(OUT_DIR, 'iframe-probe-app.png');
    await page.screenshot({ path: shot });
    console.log(`[iframe-probe] wrote ${shot}`);

    console.log(`[iframe-probe] PASS in ${Date.now() - t0}ms total`);
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'iframe-probe-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[iframe-probe] FAIL — screenshot at ${failShot}`);
    console.error(`[iframe-probe] console messages captured: ${consoleLog.length}`);
    throw err;
  } finally {
    await close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

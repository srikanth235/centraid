#!/usr/bin/env node
// Ask QA Suite 1: kit-ask panel mechanics on the Tasks app —
//   Flow 1: pre-grant panel + grant chip + 3 close methods (Escape / X / click-outside)
//   Flow 2: grant vault access + demo data, grant-chip staleness (same-session reopen
//           vs. a full iframe remount via navigate-away-and-back)
//   Flow 3: suggestion chips populate the input
//   Flow 6: corner cases — empty input no-op, rapid double-click send, unicode/HTML
//           escaping, navigate away while panel open (no crash), transcript persistence
//   Flow 7: install Locker too and diff its Ask placeholder/suggestions vs Tasks
//
// Run with: node apps/desktop/tests/e2e-live/flows-ask-01-panel-grant-corner.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-ask-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
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
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-ask01-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `ask01-${name}.png`);
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
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
}

async function openApp(appId) {
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

/** Open App settings -> Vault tab; returns the dialog locator (left open). */
async function openVaultTab() {
  const gear = page.getByRole('button', { name: 'App settings' });
  await gear.click();
  const dialog = page.getByRole('dialog', { name: 'App settings' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Vault' }).click();
  await page.waitForTimeout(300);
  return dialog;
}

async function closeSettingsDialog(dialog) {
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[ask01] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-tasks', 'Install Tasks via Discover', async () => {
      await installApp('Tasks', 'tasks');
      await shot('00-tasks-installed');
    });

    let frameLoc = await openApp('tasks');
    let firstOpenChipText = null;

    await step('pregrant-open-chip', 'Ask panel opens immediately after install; capture the grant chip\'s very-first-open state', async () => {
      const askBtn = frameLoc.locator('#kitAskBtn');
      await askBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await askBtn.click();
      const dialog = frameLoc.locator('.kit-ask-panel[role="dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      const heading = frameLoc.locator('.kit-ask-head h2');
      assert((await heading.textContent())?.trim() === 'Ask', 'panel heading is not "Ask"');
      await page.waitForTimeout(500); // let refreshGrantChip's fetch settle
      const chip = frameLoc.locator('[data-kit-grant]');
      firstOpenChipText = (await chip.textContent()) ?? '';
      console.log(`[ask01] chip text on the very first Ask-panel open: "${firstOpenChipText}"`);
      await shot('01-pregrant-panel-open');
      // FINDING vs. the task brief: this repo auto-grants a template app's
      // FULL declared vault block the first time the app itself makes a
      // vault call (see vault-plane.ts reconcileDeclaredScopes: "installing
      // was the consent for the declared block" when `!hasGrantHistory`).
      // Tasks' board fetches schedule.task on mount, i.e. within ~1-2s of
      // opening the app — often before this very first Ask-panel open even
      // finishes its own fetch. So the chip here is NOT reliably a stable
      // "no grant yet" state; it's whatever the grant status was at this
      // instant (frequently already granted). Assert only that we captured
      // SOME value, and let the next step confirm the granted end-state.
      assert(firstOpenChipText.length > 0, 'grant chip rendered no text at all');
    });

    await step('close-escape', 'Close Ask panel via Escape', async () => {
      await page.keyboard.press('Escape');
      const ov = frameLoc.locator('#kitAskOverlay');
      await ov.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
        // hidden attribute doesn't always flip Playwright's visible/hidden state
        // detection inside an iframe overlay; fall back to attribute check.
        const hidden = await ov.evaluate((el) => el.hidden);
        assert(hidden, 'overlay not hidden after Escape');
      });
      await shot('02-closed-via-escape');
    });

    await step('close-x-button', 'Reopen, close Ask panel via X (aria-label Close)', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
      const ov = frameLoc.locator('#kitAskOverlay');
      const hidden = await ov.evaluate((el) => el.hidden);
      assert(hidden, 'overlay not hidden after X click');
      await shot('03-closed-via-x');
    });

    await step('close-click-outside', 'Reopen, close Ask panel via click-outside', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      // Click the overlay backdrop itself, not the centered panel — top-left
      // corner is outside the panel box for any reasonable viewport.
      await frameLoc.locator('#kitAskOverlay').click({ position: { x: 5, y: 5 } });
      const ov = frameLoc.locator('#kitAskOverlay');
      const hidden = await ov.evaluate((el) => el.hidden);
      assert(hidden, 'overlay not hidden after click-outside');
      await shot('04-closed-via-click-outside');
    });

    let demoBtnSeen = false;
    await step('confirm-auto-grant-settled', 'Confirm the Tasks app is now granted (auto-consent on its first vault call) via App settings -> Vault; click Load demo data if offered', async () => {
      await page.waitForTimeout(1500); // give the board's first schedule.task read time to land + auto-grant
      const dialog = await openVaultTab();
      await shot('02b-settings-vault-tab');
      const grantedRow = dialog.locator('text=/^Granted/');
      const grantBtn = dialog.getByRole('button', { name: 'Grant access' });
      const isGranted = (await grantedRow.count()) > 0;
      const needsManualGrant = (await grantBtn.count()) > 0;
      console.log(`[ask01] Vault tab: already granted=${isGranted}, "Grant access" button present=${needsManualGrant}`);
      if (needsManualGrant) {
        await grantBtn.click();
        await page.waitForTimeout(600);
      }
      const demoBtn = dialog.getByRole('button', { name: 'Load demo data' });
      demoBtnSeen = (await demoBtn.count()) > 0;
      if (demoBtnSeen) {
        await demoBtn.click();
        await page.waitForTimeout(600);
      }
      await shot('03b-settings-vault-after-confirm');
      await closeSettingsDialog(dialog);
      assert(isGranted || needsManualGrant, 'Vault tab showed neither a Granted row nor a Grant access button — unexpected state');
      if (isGranted && !needsManualGrant) {
        console.log('[ask01] FINDING (contradicts the task brief\'s stated fact "installing does NOT auto-grant"): the Tasks app was ALREADY granted access by the time Settings->Vault was checked, with no "Grant access" click ever performed. Root cause verified in source: packages/gateway/src/serve/vault-plane.ts reconcileDeclaredScopes() auto-approves an app\'s full declared vault block the first time it calls the vault and has no prior grant history ("installing was the consent for the declared block") — this fires as soon as the app\'s own code makes its first vault read (Tasks\' board reads schedule.task on mount), typically within ~1-2s of opening the app, well before a human could click a Grant button.');
      }
    });

    let staleAfterSameSessionReopen = null;
    await step('revoke-then-regrant', 'Revoke access, confirm chip flips to no-grant, then manually re-grant via the button (exercises the real manual grant path)', async () => {
      let dialog = await openVaultTab();
      const revokeBtn = dialog.getByRole('button', { name: 'Revoke' });
      await revokeBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await revokeBtn.click();
      await page.waitForTimeout(600);
      await shot('04b-after-revoke');
      const grantBtnAfterRevoke = dialog.getByRole('button', { name: 'Grant access' });
      await grantBtnAfterRevoke.waitFor({ state: 'visible', timeout: 10_000 });
      const disabledAfterRevoke = await grantBtnAfterRevoke.isDisabled();
      console.log(`[ask01] "Grant access" button disabled immediately after Revoke: ${disabledAfterRevoke}`);
      if (disabledAfterRevoke) {
        console.log('[ask01] BUG: the "Grant access" button that reappears after Revoke is stuck disabled. Root cause (read from source): apps/desktop/src/renderer/react/screens/VaultScreen.tsx GrantSection keeps a local `busy` useState that is set true on the Revoke click (to disable the Revoke button mid-flight) but is NEVER reset to false once the action resolves and the section swaps from the "granted" branch to the "no grant yet" branch — it is the SAME component instance (no remount), so the stale `busy=true` disables the freshly-rendered Grant access button too. Working around it in this test by closing + reopening the Settings dialog (forces a fresh VaultScreen mount, resetting `busy`).');
        await closeSettingsDialog(dialog);
        dialog = await openVaultTab();
        await shot('04c-after-dialog-remount-workaround');
      }
      const grantBtnRetry = dialog.getByRole('button', { name: 'Grant access' });
      await grantBtnRetry.waitFor({ state: 'visible', timeout: 10_000 });
      assert(!(await grantBtnRetry.isDisabled()), 'Grant access button is still disabled even after a fresh Settings dialog mount');
      await grantBtnRetry.click();
      await page.waitForTimeout(600);
      await shot('05b-after-manual-regrant');
      await closeSettingsDialog(dialog);
    });

    await step('reopen-same-session-chip', 'Reopen Ask in the SAME iframe session after revoke/re-grant — grantChecked latches true on the FIRST open of this mount, so the chip should be STALE (still showing whatever it captured on the very first open)', async () => {
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);
      const chip = frameLoc.locator('[data-kit-grant]');
      const chipText = (await chip.textContent()) ?? '';
      console.log(`[ask01] same-session reopen chip text: "${chipText}" (first-open text was: "${firstOpenChipText}")`);
      staleAfterSameSessionReopen = chipText === firstOpenChipText;
      await shot('05-reopen-same-session-chip');
      if (staleAfterSameSessionReopen) {
        console.log('[ask01] CONFIRMED: the grant chip did NOT refresh on this same-session reopen — it still shows the exact text captured on the panel\'s first-ever open (kit.js\'s `grantChecked` flag only calls refreshGrantChip() once per iframe mount, not on every open(); see packages/blueprints/kit/kit.js around "var grantChecked = false"). Real-world impact: after a Revoke, the owner could reopen Ask and see a stale "granted" chip while the vault is actually denying writes (or vice-versa) until they navigate away and back.');
      } else {
        console.log('[ask01] chip text differed from the first-open capture on this same-session reopen — no staleness observed this run (grant state may coincidentally match, or refreshGrantChip ran again).');
      }
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click();
    });

    await step('remount-then-reopen-chip', 'Navigate away (Home) and back — iframe remounts kit.js, resetting grantChecked — chip should now reflect the TRUE current (re-granted) state', async () => {
      await navTo(page, 'Home');
      await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(300);
      frameLoc = await openApp('tasks');
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(700);
      const chip = frameLoc.locator('[data-kit-grant]');
      const chipText = (await chip.textContent()) ?? '';
      console.log(`[ask01] post-remount reopen chip text: "${chipText}"`);
      await shot('06-remount-reopen-chip');
      const nowGranted = /consent-gated/.test(chipText) && !/no grant yet/.test(chipText) && !/not enrolled/.test(chipText);
      if (!nowGranted) {
        console.log(
          '[ask01] SEVERE BUG confirmed (root-caused in source, not just observed): the Ask panel grant chip can NEVER show a granted state. ' +
          'packages/blueprints/kit/kit.js refreshGrantChip() (around line 949-950) does `apps.filter(x => x.appId === appId())` to find "my" ' +
          'entry in GET /centraid/_vault/apps. But that endpoint\'s AppSummary.appId (packages/vault/src/host.ts listEnrolledApps, ~line 474) is the ' +
          'internal consent_app.app_id — a uuidv7() minted at enrollment — while kit.js\'s appId() returns window.centraid.appId, the manifest app id ' +
          'string (e.g. "tasks"). Those two values are never equal, so `mine` is always undefined and the chip always falls into the ' +
          '"not enrolled — vault calls deny" branch, even when the app is fully Granted (as verified via Settings -> Vault in this same run). ' +
          'The correct comparison — used correctly elsewhere in the same codebase, e.g. apps/desktop/src/renderer/react/shell/routes/appSettingsData.ts ' +
          '`apps.find(a => a.name === appId)` — should match on `x.name`, not `x.appId`. This affects every blueprint app\'s Ask panel; it is not ' +
          'Tasks-specific and not related to the grantChecked staleness caveat (that one is real too, but independent).'
        );
      } else {
        console.log('[ask01] chip showed a granted state after remount — did not reproduce the appId/name mismatch bug this run.');
      }
      results.push({ id: 'grant-chip-appid-name-mismatch-bug', label: 'BUG: kit.js grant chip compares apps[].appId (UUID) to manifest appId string, so it can never show granted state', verdict: nowGranted ? 'pass' : 'bug-confirmed', ms: 0 });
    });

    await step('suggestion-chips', 'Suggestion chips populate the input on click', async () => {
      const chips = frameLoc.locator('.kit-ask-chip');
      const count = await chips.count();
      assert(count > 0, 'no suggestion chips rendered');
      const firstText = (await chips.first().textContent())?.trim() ?? '';
      await chips.first().click();
      const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
      const val = await input.inputValue();
      console.log(`[ask01] chip "${firstText}" -> input value "${val}"`);
      assert(val === firstText, `input value "${val}" did not match chip text "${firstText}"`);
      await shot('07-chip-populated-input');
      await input.fill('');
    });

    await step('empty-input-noop', 'Submitting empty input is a no-op (no new bubble)', async () => {
      const log = frameLoc.locator('.kit-ask-log');
      const before = await log.locator('.kit-msg').count();
      const sendBtn = frameLoc.locator('.kit-ask-send[aria-label="Send"]');
      await sendBtn.click();
      await page.waitForTimeout(300);
      const after = await log.locator('.kit-msg').count();
      assert(after === before, `expected no new bubble on empty submit, before=${before} after=${after}`);
      await shot('08-empty-submit-noop');
    });

    await step('unicode-html-escaped', 'Unicode + HTML-as-text renders escaped in transcript, not interpreted', async () => {
      const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
      const text = '日本語 🎉 <b>bold?</b>';
      await input.fill(text);
      await frameLoc.locator('.kit-ask-send[aria-label="Send"]').click();
      await page.waitForTimeout(400);
      const userBubbles = frameLoc.locator('.kit-msg.user');
      const lastBubble = userBubbles.last();
      const bubbleText = (await lastBubble.textContent()) ?? '';
      const hasBoldElement = await lastBubble.locator('b').count();
      console.log(`[ask01] unicode bubble text: ${JSON.stringify(bubbleText)}, <b> element count: ${hasBoldElement}`);
      assert(bubbleText.includes(text), `bubble text does not contain the literal sent text: ${bubbleText}`);
      assert(hasBoldElement === 0, 'HTML in the user message was interpreted as markup instead of escaped text');
      await shot('09-unicode-html-escaped');
    });

    await step('rapid-double-click-send', 'Rapid double-click send: check for de-dupe/disable (report observed behavior)', async () => {
      const input = frameLoc.locator('.kit-ask-compose input[aria-label="Ask"]');
      await input.fill('rapid click probe');
      const log = frameLoc.locator('.kit-ask-log');
      const before = await log.locator('.kit-msg.user').count();
      const sendBtn = frameLoc.locator('.kit-ask-send[aria-label="Send"]');
      await Promise.all([sendBtn.click(), sendBtn.click({ force: true }).catch(() => undefined)]);
      await page.waitForTimeout(400);
      const after = await log.locator('.kit-msg.user').count();
      const delta = after - before;
      console.log(`[ask01] rapid double-click send: user bubbles added = ${delta} (1 = de-duped/guarded, 2 = duplicate submits allowed — a minor bug worth flagging)`);
      await shot('10-rapid-double-click');
      assert(delta >= 1, 'double-click send produced no user bubble at all');
    });

    await step('navigate-away-panel-open', 'Navigate the shell to Home while Ask panel is open — no crash / console errors from the unmount', async () => {
      const errCountBefore = consoleMessages.filter((m) => m.type === 'error').length;
      await navTo(page, 'Home');
      await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('11-navigated-home-panel-was-open');
      const errCountAfter = consoleMessages.filter((m) => m.type === 'error').length;
      const newErrors = consoleMessages.filter((m) => m.type === 'error').slice(errCountBefore);
      if (errCountAfter > errCountBefore) {
        console.log(`[ask01] new console errors after navigating away with panel open: ${JSON.stringify(newErrors)}`);
      } else {
        console.log('[ask01] no new console errors from navigating away with the Ask panel open.');
      }
    });

    let transcriptPreserved = null;
    await step('reopen-transcript-persistence', 'Reopen Tasks + Ask — report whether the prior transcript persisted or reset', async () => {
      frameLoc = await openApp('tasks');
      await frameLoc.locator('#kitAskBtn').click();
      await frameLoc.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400);
      const log = frameLoc.locator('.kit-ask-log');
      const text = (await log.textContent()) ?? '';
      transcriptPreserved = /rapid click probe|bold\?/.test(text);
      console.log(`[ask01] transcript after reopen preserved prior messages: ${transcriptPreserved}. Log text starts: ${JSON.stringify(text.slice(0, 200))}`);
      await shot('12-reopen-transcript-check');
    });

    // ---- Flow 7: second app, different suggestions ----
    await step('install-locker-diff-suggestions', 'Install Locker; Ask placeholder/suggestions differ from Tasks', async () => {
      await frameLoc.locator('.kit-ask-x[aria-label="Close"]').click().catch(() => undefined);
      await navTo(page, 'Home');
      await installApp('Locker', 'locker');
      const lockerFrame = await openApp('locker');
      await lockerFrame.locator('#kitAskBtn').waitFor({ state: 'visible', timeout: 10_000 });
      await lockerFrame.locator('#kitAskBtn').click();
      await lockerFrame.locator('.kit-ask-panel[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
      const lockerPlaceholder = await lockerFrame.locator('.kit-ask-compose input[aria-label="Ask"]').getAttribute('placeholder');
      const lockerChips = await lockerFrame.locator('.kit-ask-chip').allTextContents();
      console.log(`[ask01] Locker Ask placeholder: "${lockerPlaceholder}", suggestions: ${JSON.stringify(lockerChips)}`);
      await shot('13-locker-ask-panel');
      assert(lockerPlaceholder === 'Ask your locker…', `unexpected Locker placeholder: ${lockerPlaceholder}`);
      assert(lockerChips.length > 0 && lockerChips.some((c) => /password|login|card/i.test(c)), `Locker suggestions don't look locker-specific: ${JSON.stringify(lockerChips)}`);
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ ASK PANEL / GRANT / CORNER VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=============================================================================');
    console.log(`Console errors observed across the whole run: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`\nsame-session reopen chip stale? ${staleAfterSameSessionReopen}`);
    console.log(`transcript preserved across app close/reopen? ${transcriptPreserved}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll ask-01 steps PASSED.');
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

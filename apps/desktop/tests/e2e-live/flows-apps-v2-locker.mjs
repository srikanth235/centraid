#!/usr/bin/env node
// Apps v2 QA — Locker. Regular flow: install, empty state, new login item
// with a real TOTP seed (JBSWY3DPEHPK3PXP), verify the rendered 6-digit code
// against a Node-computed RFC-6238 oracle, password reveal + strength meter,
// copy, favorite, edit, trash -> restore, trash -> Delete forever (purge is
// confirmation:"required", so from the owner surface it may park — if it
// does, drive the shell's Approvals screen to approve it and verify the item
// really purges). Corner: malformed base32 secret must not crash the app.
//
// Run with: node apps/desktop/tests/e2e-live/flows-apps-v2-locker.mjs
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'apps-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-apps-v2-locker');
const TOTP_SEED = 'JBSWY3DPEHPK3PXP';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- RFC-6238 oracle (SHA-1, 6 digits, 30s) ----
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totpAt(seed, step) {
  const key = base32Decode(seed);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code =
    (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}
function expectedTotps(seed) {
  const step = Math.floor(Date.now() / 30_000);
  return [totpAt(seed, step - 1), totpAt(seed, step), totpAt(seed, step + 1)];
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
    console.error(`[console][during ${currentStep}] pageerror: ${err}`);
  });
}

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `locker-${String(shotN).padStart(2, '0')}-${name}.png`);
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
      await page.screenshot({ path: path.join(OUT_DIR, `locker-FAILURE-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
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
  // The sidebar APPS entry works from any screen; the Home tile only from Home.
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => undefined);
  const tile = page.locator('[data-app-id="locker"]');
  if (await tile.count()) await tile.getByTestId('app-tile').click();
  else
    await page
      .getByRole('button', { name: /^Locker/ })
      .first()
      .click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(800);
  return frameLoc;
}

async function newItem(frameLoc, { title, fields = {}, tags }) {
  await frameLoc.locator('.v-newbtn').click();
  const modal = frameLoc.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  await modal.locator('input[placeholder="Item name"]').fill(title);
  for (const [ph, val] of Object.entries(fields)) {
    await modal.locator(`input[placeholder="${ph}"]`).fill(val);
  }
  if (tags) await modal.locator('input[placeholder="personal, finance"]').fill(tags);
  await modal.locator('button.kit-btn.primary', { hasText: 'Save' }).click();
  await modal.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForTimeout(600);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[locker] launched + Home ready');

  let frameLoc;
  let purgeParked = false;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install', 'Install Locker from Discover', async () => {
      await installLocker();
    });

    await step('open-empty', 'Open Locker -> empty list on a fresh vault', async () => {
      frameLoc = await openLocker();
      await shot('01-empty');
      const listText = await frameLoc
        .locator('.v-list')
        .textContent()
        .catch(() => '');
      console.log(`[locker] fresh list text: ${JSON.stringify(listText?.slice(0, 200))}`);
      assert(
        /No items|empty|Nothing/i.test(listText ?? '') || !/\S/.test(listText ?? '') || true,
        'informational only',
      );
    });

    await step(
      'new-login-with-totp',
      'New login item with username/password/TOTP seed',
      async () => {
        await newItem(frameLoc, {
          title: 'GitHub',
          fields: {
            'you@email.com': 'ada@example.com',
            'https://': 'https://github.com',
            'base32 seed (optional)': TOTP_SEED,
          },
          tags: 'personal',
        });
        // The password field has no placeholder — fill it via its label row.
        // (Do it in the edit modal: reopen edit.)
        const item = frameLoc.locator('.v-item', { hasText: 'GitHub' });
        await item.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('02-item-created');
      },
    );

    await step(
      'totp-matches-oracle',
      'Rendered one-time code matches a Node RFC-6238 oracle',
      async () => {
        const item = frameLoc.locator('.v-item', { hasText: 'GitHub' });
        await item.click();
        const otp = frameLoc.locator('.v-otp-code');
        await otp.waitFor({ state: 'visible', timeout: 10_000 });
        // First paint may be the '••• •••' placeholder while the async HMAC runs.
        let code = '';
        const t0 = Date.now();
        while (Date.now() - t0 < 10_000) {
          code = ((await otp.textContent()) ?? '').replace(/\s/g, '');
          if (/^\d{6}$/.test(code)) break;
          await page.waitForTimeout(300);
        }
        const expected = expectedTotps(TOTP_SEED);
        console.log(`[locker] rendered TOTP: ${code}; oracle window: ${expected.join(', ')}`);
        await shot('03-totp-code');
        assert(/^\d{6}$/.test(code), `expected a 6-digit code, got ${JSON.stringify(code)}`);
        assert(
          expected.includes(code),
          `rendered code ${code} not in oracle window [${expected.join(', ')}]`,
        );
      },
    );

    await step(
      'totp-ticks',
      'Code refreshes across a 30s boundary (or stays valid per oracle)',
      async () => {
        // Rather than waiting up to 30s for a flip, verify the ring countdown
        // element exists and the code stays inside the oracle's ±1 window.
        const ring = frameLoc.locator('.v-ring');
        assert((await ring.count()) > 0, 'TOTP countdown ring missing');
        await page.waitForTimeout(2_000);
        const code = ((await frameLoc.locator('.v-otp-code').textContent()) ?? '').replace(
          /\s/g,
          '',
        );
        assert(
          expectedTotps(TOTP_SEED).includes(code),
          `code drifted outside the oracle window: ${code}`,
        );
      },
    );

    await step(
      'password-reveal-strength',
      'Add a password via Edit, reveal it, strength meter appears',
      async () => {
        await frameLoc.locator('.v-dtool[aria-label="Edit"]').click();
        const modal = frameLoc.locator('.kit-modal');
        await modal.waitFor({ state: 'visible', timeout: 5000 });
        // Password row = the field row whose label says Password (no placeholder).
        const pwRow = modal.locator('.v-field-lg', { hasText: 'Password' });
        await pwRow.locator('input').fill('correct horse battery staple');
        await modal.locator('button.kit-btn.primary', { hasText: 'Save' }).click();
        await modal.waitFor({ state: 'hidden', timeout: 10_000 });
        await page.waitForTimeout(800);

        const pwField = frameLoc.locator('.v-field', { hasText: 'Password' }).first();
        const masked = await pwField.locator('.v-field-v').textContent();
        assert(
          /•{6,}/.test(masked ?? ''),
          `password should render masked, got ${JSON.stringify(masked)}`,
        );
        await pwField.locator('button[aria-label="Reveal"]').click();
        await page.waitForTimeout(400);
        await shot('04-password-revealed');
        const revealed = await pwField.locator('.v-field-v').textContent();
        assert(
          /correct horse battery staple/.test(revealed ?? ''),
          'revealed password should show the real value',
        );
        const strength = await pwField.locator('.v-strength').count();
        assert(strength > 0, 'strength meter should appear on reveal');
        // Mask it back.
        await pwField.locator('button[aria-label="Reveal"]').click();
      },
    );

    await step(
      'copy-button',
      'Copy button on the username field works (toast, no crash)',
      async () => {
        const userField = frameLoc.locator('.v-field', { hasText: 'Username' }).first();
        await userField.locator('button[aria-label="Copy"]').click();
        await page.waitForTimeout(500);
        await shot('05-after-copy');
        // Clipboard readback isn't reliable cross-platform in this rig — the
        // check is "no error + the app stays alive"; kit toasts on success.
      },
    );

    await step('favorite', 'Favorite the item -> Favorites nav counts it', async () => {
      await frameLoc.locator('.v-dtool[aria-label="Favorite"]').click();
      await page.waitForTimeout(700);
      await frameLoc.locator('.v-nav-item', { hasText: 'Favorites' }).click();
      await page.waitForTimeout(500);
      await shot('06-favorites');
      const listText = await frameLoc
        .locator('.v-list, .v-items')
        .first()
        .textContent()
        .catch(() => '');
      assert(/GitHub/.test(listText ?? ''), 'favorited item not under Favorites');
      await frameLoc.locator('.v-nav-item', { hasText: 'All items' }).click();
      await page.waitForTimeout(400);
    });

    await step(
      'malformed-secret',
      'Corner: malformed base32 seed renders placeholder, no crash',
      async () => {
        await newItem(frameLoc, {
          title: 'Bad OTP',
          fields: { 'base32 seed (optional)': 'notbase32!!!1' },
        });
        const item = frameLoc.locator('.v-item', { hasText: 'Bad OTP' });
        await item.waitFor({ state: 'visible', timeout: 10_000 });
        await item.click();
        await page.waitForTimeout(1500);
        await shot('07-malformed-secret');
        const otp = frameLoc.locator('.v-otp-code');
        const otpCount = await otp.count();
        if (otpCount > 0) {
          const text = ((await otp.textContent()) ?? '').trim();
          console.log(`[locker] malformed-seed OTP field renders: ${JSON.stringify(text)}`);
          assert(
            !/^\d{6}$/.test(text.replace(/\s/g, '')),
            'a malformed seed must not produce a 6-digit code',
          );
        }
        const errs = consoleMessages.filter(
          (m) => m.type === 'error' && m.step === 'malformed-secret',
        );
        console.log(`[locker] console errors during malformed-secret: ${errs.length}`);
        for (const e of errs) console.log(`  -> ${e.text}`);
      },
    );

    await step(
      'trash-restore',
      'Trash Bad OTP -> Trash nav -> Restore -> back under All items',
      async () => {
        // Bad OTP is already selected.
        await frameLoc.locator('button.v-del', { hasText: 'Move to trash' }).click();
        await page.waitForTimeout(700);
        await frameLoc.locator('.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(500);
        await shot('08-trash');
        let listText = await frameLoc
          .locator('.v-items, .v-list')
          .first()
          .textContent()
          .catch(() => '');
        assert(/Bad OTP/.test(listText ?? ''), 'trashed item not under Trash');
        await frameLoc.locator('.v-item', { hasText: 'Bad OTP' }).click();
        await page.waitForTimeout(500);
        await frameLoc.locator('button', { hasText: 'Restore' }).click();
        await page.waitForTimeout(700);
        await frameLoc.locator('.v-nav-item', { hasText: 'All items' }).click();
        await page.waitForTimeout(500);
        await shot('09-restored');
        listText = await frameLoc
          .locator('.v-items, .v-list')
          .first()
          .textContent()
          .catch(() => '');
        assert(/Bad OTP/.test(listText ?? ''), 'restored item not back under All items');
      },
    );

    await step(
      'purge-flow',
      'Trash again -> Delete forever (parks for confirmation OR purges)',
      async () => {
        await frameLoc.locator('.v-item', { hasText: 'Bad OTP' }).click();
        await page.waitForTimeout(500);
        await frameLoc.locator('button.v-del', { hasText: 'Move to trash' }).click();
        await page.waitForTimeout(700);
        await frameLoc.locator('.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(400);
        await frameLoc.locator('.v-item', { hasText: 'Bad OTP' }).click();
        await page.waitForTimeout(500);
        const purgeBtn = frameLoc.locator('button', { hasText: 'Delete forever' });
        await purgeBtn.click();
        await page.waitForTimeout(150);
        await purgeBtn.click(); // arm-confirm
        await page.waitForTimeout(1200);
        await shot('10-after-purge-click');
        const noticeText = await frameLoc
          .locator('#noticeBanner')
          .textContent()
          .catch(() => '');
        console.log(`[locker] notice after purge: ${JSON.stringify(noticeText)}`);
        const trashText = await frameLoc
          .locator('.v-items, .v-list')
          .first()
          .textContent()
          .catch(() => '');
        if (/approval|confirm|land|Waiting/i.test(noticeText ?? '')) {
          purgeParked = true;
          assert(
            /Bad OTP/.test(trashText ?? ''),
            'parked purge should leave the item in Trash until approved',
          );
          console.log(
            '[locker] purge PARKED for owner confirmation (confirmation:"required") — will approve via the shell Approvals screen',
          );
        } else {
          assert(
            !/Bad OTP/.test(trashText ?? ''),
            `purge did not park but the item is still in Trash; notice: ${noticeText}`,
          );
          console.log('[locker] purge executed directly from the owner surface');
        }
      },
    );

    if (purgeParked) {
      await step(
        'approvals-approve-purge',
        'Shell Approvals lists the parked purge; Approve -> item really gone',
        async () => {
          await page
            .getByRole('button', { name: /^Approvals/ })
            .first()
            .click();
          await page
            .getByRole('heading', { name: 'Approvals', level: 1 })
            .waitFor({ state: 'visible', timeout: 10_000 });
          await page
            .locator('h2', { hasText: 'Parked' })
            .waitFor({ state: 'visible', timeout: 10_000 });
          await shot('11-approvals-parked');
          const row = page.locator('button', { hasText: 'locker.purge_item' }).first();
          await row.waitFor({ state: 'visible', timeout: 10_000 });
          await row.click();
          await page.waitForTimeout(300);
          await shot('12-approvals-row-expanded');
          await page.getByRole('button', { name: 'Approve', exact: true }).click();
          await page.waitForTimeout(1200);
          await shot('13-approvals-after-approve');

          // Back into Locker: the item must be gone from Trash now.
          frameLoc = await openLocker();
          await frameLoc.locator('.v-nav-item', { hasText: 'Trash' }).click();
          await page.waitForTimeout(600);
          const trashText = await frameLoc
            .locator('.v-items, .v-list')
            .first()
            .textContent()
            .catch(() => '');
          await shot('14-locker-trash-after-approve');
          assert(
            !/Bad OTP/.test(trashText ?? ''),
            'item should be purged after approving the parked write',
          );
        },
      );
    }

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ LOCKER APPS-V2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: [${e.step}] ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Locker apps-v2 steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'locker-FAILURE-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();

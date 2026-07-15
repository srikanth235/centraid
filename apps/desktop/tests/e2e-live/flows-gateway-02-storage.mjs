#!/usr/bin/env node
// Storage card + Settings → Storage E2E against the REAL desktop app —
// real embedded gateway, real StorageConnectionStore (sealed on disk), real
// S3-compatible test server (@centraid/backup's S3TestServer, same one
// packages/gateway/src/backup/storage-e2e.test.ts uses), no mocks anywhere.
// Run with:
//   node apps/desktop/tests/e2e-live/flows-gateway-02-storage.mjs
// (prereq: `bun run build --filter=@centraid/desktop` from repo root)
//
// Path: launch → Gateway page Overview shows the Storage card's empty state
// → the empty state's "Settings → Storage" link deep-links straight into
// Settings' Storage sub-page (issue #367 §D3's page param) → the Settings
// screen ALSO starts empty → open the add-connection form, fill in a
// byo-s3 connection pointed at a real local S3TestServer, submit → the
// recovery-kit gate blocks it (409) → "I've saved my recovery kit" 409s
// too (the desktop's embedded local gateway never wires a `backup` block,
// same NEEDS-WIRING gap flows-gateway-01 already documents for the Backup
// card — the confirm route requires `backupService`) → "Proceed anyway"
// succeeds → Test connection reports a real signed-request success → back
// on the Gateway page, the Storage card now shows the connection with a
// "locally verified" line (byo-s3 has no provider usage endpoint) → back
// in Settings, attach the connection to this vault's CAS tier (same gate,
// same proceed-anyway path since the recovery kit still isn't confirmed) →
// Detach reverts to local-only.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';
import { S3TestServer } from '../../../../packages/backup/dist/testing/s3-test-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'userdata-gw02');
  await fs.rm(userDataDir, { recursive: true, force: true });

  const s3 = await S3TestServer.start();
  console.log(`[gw02] real S3TestServer up at ${s3.url}`);

  const session = await launchApp({ userDataDir });
  const { page } = session;
  console.log(`[gw02] launched (userData=${userDataDir})`);

  try {
    await page.setViewportSize({ width: 1400, height: 950 });

    // 1 — Gateway page → Overview → Storage card's empty state.
    const gatewayNav = page.getByRole('button', { name: /^Gateway/ }).first();
    await gatewayNav.waitFor({ state: 'visible', timeout: 20_000 });
    await gatewayNav.click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByText('No remote storage connected yet').waitFor({
      state: 'visible',
      timeout: 15_000,
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-1-storage-empty.png') });
    console.log('[gw02] Storage card empty state renders on Overview');

    // 2 — the empty state's inline link deep-links into Settings → Storage.
    const settingsLink = page.getByRole('button', { name: 'Settings → Storage' });
    await settingsLink.waitFor({ state: 'visible', timeout: 10_000 });
    await settingsLink.click();
    await page
      .getByRole('heading', { name: 'Storage' })
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText('No storage connections configured yet.').waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-2-settings-storage-empty.png') });
    console.log(
      '[gw02] deep-linked straight into Settings → Storage, empty state renders there too',
    );

    // 3 — open the add-connection form and fill in a byo-s3 connection
    // pointed at the real local S3TestServer.
    await page.getByRole('button', { name: 'Add connection' }).click();
    // Labels wrap their inputs (`<label><span>Text</span><input/></label>`),
    // so Playwright's accessible-name computation resolves getByLabel
    // against the real (Vite-hashed) CSS-module build — no class-name
    // coupling, unlike the .module.css selectors the vitest unit tests can
    // use (those run against an identity-mapped CSS-module transform).
    await page.getByLabel('Name', { exact: true }).fill('Local S3 test bucket');
    await page.getByLabel('Endpoint', { exact: true }).fill(s3.url);
    await page.getByLabel('Region', { exact: true }).fill('us-east-1');
    await page.getByLabel('Bucket', { exact: true }).fill('e2e-test-bucket');
    await page.getByLabel('Access key ID', { exact: true }).fill('AKIA_E2E_TEST');
    await page.getByLabel('Secret access key', { exact: true }).fill('e2e-secret-value');
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-3-add-form-filled.png') });

    // The outer toggle button is gone while the form is open (conditional
    // render), so this now resolves to the form's own submit button.
    const saveBtn = page.getByRole('button', { name: 'Add connection' });
    await saveBtn.click();
    console.log('[gw02] add-connection form submitted');

    // 4 — the recovery-kit gate blocks it (no confirmation on this fresh
    // profile). Assert the dialog + its explanatory copy.
    await page.getByRole('dialog', { name: 'Confirm your recovery kit' }).waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    const dialogText = await page.getByRole('dialog').textContent();
    assert(dialogText.includes('recovery kit'), 'gate dialog explains the recovery kit');
    // The dialog fades/rises in over ~0.22s (modal.module.css); wait it out
    // so the screenshot captures the settled layout, not a mid-animation frame.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-4-recovery-kit-gate.png') });
    console.log('[gw02] recovery-kit gate dialog appeared on create');

    // 5 — "I've saved my recovery kit" 409s for real: the desktop's
    // embedded local gateway never wires a `backup` config block, so
    // `POST _gateway/backup/kit-confirmed` answers `not_configured` (see
    // flows-gateway-01-runtime-page.mjs's identical NEEDS-WIRING note for
    // the Backup card). The dialog must surface that inline, not crash or
    // silently proceed.
    await page.getByRole('button', { name: "I've saved my recovery kit" }).click();
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog && /not.configured|backup is not configured/i.test(dialog.textContent ?? '');
      },
      { timeout: 10_000 },
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-5-confirm-kit-409.png') });
    console.log(
      '[gw02] confirming the recovery kit 409s honestly (backup not wired on the embedded gateway) — dialog stays open with the real error',
    );

    // 6 — "Proceed anyway" bypasses the gate with {force: true} and the
    // connection is created for real.
    await page.getByRole('button', { name: 'Proceed anyway' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10_000 });
    const connectionRow = page.getByTestId('storage-connection-row');
    await connectionRow
      .getByText('Local S3 test bucket')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await connectionRow.getByText('BYO S3').waitFor({ state: 'visible', timeout: 5000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-6-connection-created.png') });
    console.log('[gw02] "Proceed anyway" created the connection for real (force:true bypass)');

    // 7 — Test connection: a real signed HEAD against the real S3TestServer.
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.waitForSelector('[data-testid="storage-test-result"]', { timeout: 15_000 });
    const testResult = await page.locator('[data-testid="storage-test-result"]').textContent();
    assert(
      /accepted|reached the bucket/i.test(testResult ?? ''),
      `Test connection reports success: ${testResult}`,
    );
    const s3SawRequest = s3.requests.some((r) => r.method === 'HEAD');
    assert(s3SawRequest, 'the real S3TestServer actually received a signed HEAD request');
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-7-test-connection-ok.png') });
    console.log(
      `[gw02] Test connection: "${testResult}" — S3TestServer saw ${s3.requests.length} real request(s)`,
    );

    // 8 — back on the Gateway page, the Storage card reflects the new
    // connection: byo-s3 has no provider usage endpoint, so it renders the
    // "locally verified" line, no quota bar.
    await gatewayNav.click();
    await page.getByText('Local S3 test bucket').waitFor({ state: 'visible', timeout: 15_000 });
    const storageCardText = await page
      .locator('[data-testid="storage-connection-panel"]')
      .textContent();
    assert(
      storageCardText.includes('locally verified'),
      'Storage card shows the locally-verified drift line',
    );
    assert(
      !storageCardText.includes('of') || !(await page.locator('[data-testid="quota-bar"]').count()),
      'no quota bar for a byo-s3 connection',
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-8-storage-card-with-connection.png') });
    console.log('[gw02] Gateway page Storage card reflects the configured connection');

    // 9 — per-vault CAS attach: same recovery-kit gate (shared store),
    // same proceed-anyway path (confirm still 409s — backup still isn't
    // wired). Detach afterward reverts to local-only, ungated. Navigate
    // back in via the sidebar (the empty-state's inline link from step 2 is
    // gone now that a connection exists) then click into Storage explicitly.
    await page
      .getByRole('button', { name: /^Settings/ })
      .first()
      .click();
    const storageNavItem = page.getByRole('button', { name: 'Storage', exact: true });
    await storageNavItem.waitFor({ state: 'visible', timeout: 10_000 });
    await storageNavItem.click();
    await page
      .getByText('stores blobs locally only')
      .waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('button', { name: 'Attach' }).click();
    await page.getByRole('dialog', { name: 'Confirm your recovery kit' }).waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Proceed anyway' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByText("This vault's blobs replicate through").waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-9-vault-attached.png') });
    console.log(
      '[gw02] per-vault CAS attach: gated the same way, "proceed anyway" attached it for real',
    );

    await page.getByRole('button', { name: 'Detach' }).click();
    await page
      .getByText('stores blobs locally only')
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[gw02] Detach reverted the vault to local-only (ungated, as expected)');

    console.log('[gw02] PASS');
  } catch (err) {
    await page.screenshot({ path: path.join(OUT_DIR, 'gw02-FAIL.png') }).catch(() => undefined);
    throw err;
  } finally {
    await session.close();
    await s3.close();
  }
}

main().catch((err) => {
  console.error('[gw02] FAIL:', err);
  process.exit(1);
});

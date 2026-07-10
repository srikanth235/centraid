#!/usr/bin/env node
// Root-cause probe for the "installed app flips to DRAFT after vault
// switch" bug found by flows-shell-v2-02. Installs Notes, dumps /_apps,
// creates + switches to a second vault, switches back, dumps /_apps again
// and the tile's badge state. Read-only against product code.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-probe-draft');

async function dumpApps(page, label) {
  const diag = await page.evaluate(async () => {
    const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
    const res = await fetch(`${baseUrl}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json().catch(() => null);
  });
  console.log(`[probe] /_apps ${label}: ${JSON.stringify(diag)}`);
  return diag;
}

async function badgeState(page, label) {
  const tile = page.locator('[data-app-id="notes"]');
  const text = await tile.innerText().catch(() => '(no tile)');
  console.log(`[probe] tile text ${label}: ${JSON.stringify(text)}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  const { page } = session;
  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // Install Notes.
    await navTo(page, 'Discover');
    const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
    await card.waitFor({ state: 'visible', timeout: 20_000 });
    await card.click();
    const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
    await badgeState(page, 'after install');
    await dumpApps(page, 'after install');

    // Create second vault via the same IPC surface the SpaceModal uses.
    const created = await page.evaluate(async () => {
      const v = await window.CentraidApi.createVault({ name: 'Probe Space' });
      await window.CentraidApi.setActiveVault({ vaultId: v.vaultId });
      return v;
    });
    console.log(`[probe] created vault: ${JSON.stringify(created)}`);
    await page.waitForTimeout(1_500);

    // Switch back to the primary vault (vault list comes from the gateway HTTP API).
    const vaults = await page.evaluate(async () => {
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const res = await fetch(`${baseUrl}/centraid/_vault/vaults`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      return body.vaults ?? body;
    });
    console.log(`[probe] vaults: ${JSON.stringify(vaults)}`);
    const primary = vaults.find((v) => v.vaultId !== created.vaultId);
    await page.evaluate(async (vaultId) => {
      await window.CentraidApi.setActiveVault({ vaultId });
    }, primary.vaultId);
    await page.waitForTimeout(1_500);
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });

    await badgeState(page, 'after switch back');
    await dumpApps(page, 'after switch back');
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

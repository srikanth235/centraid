#!/usr/bin/env node
// Gateway runtime page E2E against the REAL desktop app — real embedded
// gateway, real heartbeat monitor, no mocks. Run with:
//   node apps/desktop/tests/e2e-live/flows-gateway-01-runtime-page.mjs
// (prereq: `bun run build --filter=@centraid/desktop` from repo root)
//
// Path: launch → sidebar shows the live heartbeat pill → Gateway page renders
// Operational with server uptime + heartbeat strip → change the down-alert
// threshold (persists to centraid-settings.json) → toggle alerts off/on →
// switch to a dead remote gateway → page flips to Unreachable and opens an
// ongoing outage → switch back to local → recovers to Operational.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { page, userDataDir, close } = await launchApp();
  console.log(`[gw01] launched (userData=${userDataDir})`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // The sidebar row's accessible name is "Gateway" plus the live pill text
    // once the first heartbeat lands ("Gateway up") — match by prefix.
    const gatewayNav = page.getByRole('button', { name: /^Gateway/ }).first();
    await gatewayNav.waitFor({ state: 'visible', timeout: 20_000 });

    // 1 — the sidebar pill goes live off the first heartbeat.
    await page
      .getByRole('button', { name: 'Gateway up', exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
    console.log('[gw01] sidebar heartbeat pill is "up"');

    // 2 — open the page; hero renders Operational with real runtime data.
    await gatewayNav.click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 20_000 });
    const heroText = await page.locator('[data-status]').first().textContent();
    assert(heroText.includes('local gateway'), `hero names the local gateway: ${heroText.slice(0, 200)}`);
    assert(/Gateway uptime/i.test(heroText), 'uptime figure present');
    assert(/Availability/i.test(heroText), 'availability figure present');
    const beats = await page.locator('[data-ok]').count();
    assert(beats >= 1, `heartbeat strip has ticks (got ${beats})`);
    assert(heroText.includes('100.0%'), `availability reads 100.0%: ${heroText.slice(0, 300)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-1-operational.png') });
    console.log(`[gw01] Operational hero + ${beats} heartbeat ticks`);

    // 3 — the down-alert default is 2m; move it to 5m and confirm it persists.
    const twoMin = page.getByRole('button', { name: '2m', exact: true });
    assert(
      (await twoMin.getAttribute('class')).includes('presetActive'),
      '2m default preset is active',
    );
    await page.getByRole('button', { name: '5m', exact: true }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === '5m' && b.className.includes('presetActive'),
        ),
      { timeout: 15_000 },
    );
    const settingsRaw = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'centraid-settings.json'), 'utf8'),
    );
    assert(
      settingsRaw.gatewayAlertSeconds === 300,
      `threshold persisted (got ${settingsRaw.gatewayAlertSeconds})`,
    );
    console.log('[gw01] threshold 2m → 5m, persisted to centraid-settings.json');

    // 4 — toggle alerts off; the ladder dims and the flag persists.
    await page.getByRole('switch').click();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false',
      { timeout: 15_000 },
    );
    const settingsOff = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'centraid-settings.json'), 'utf8'),
    );
    assert(settingsOff.gatewayAlertsEnabled === false, 'alerts-off persisted');
    await page.getByRole('switch').click(); // back on
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-2-alert-card.png') });
    console.log('[gw01] alert toggle round-trips through settings');

    // 5 — point the app at a dead remote gateway: the monitor should flip to
    // Unreachable and open an ongoing outage. Port 9 on loopback (discard) is
    // reliably closed.
    await page.evaluate(async () => {
      const profile = await window.CentraidApi.addGateway({
        label: 'Dead VPS',
        url: 'http://127.0.0.1:9',
        token: 'dead-token',
      });
      await window.CentraidApi.setActiveGateway({ id: profile.id });
    });
    // Gateway switch bounces the shell home; navigate back to the page.
    await page.getByRole('button', { name: /^Gateway/ }).first().click();
    await page
      .getByText('Unreachable', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('— ongoing').waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .getByRole('button', { name: 'Gateway down', exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-3-unreachable.png') });
    console.log('[gw01] dead gateway → Unreachable + ongoing outage + red sidebar pill');

    // 6 — switch back to local: tracking re-keys and recovers to Operational.
    await page.evaluate(async () => {
      await window.CentraidApi.setActiveGateway({ id: 'local' });
    });
    await page.getByRole('button', { name: /^Gateway/ }).first().click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-4-recovered.png') });
    console.log('[gw01] back on local → Operational again');

    console.log('[gw01] PASS');
  } catch (err) {
    await page
      .screenshot({ path: path.join(OUT_DIR, 'gw01-FAIL.png') })
      .catch(() => undefined);
    throw err;
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('[gw01] FAIL:', err);
  process.exit(1);
});

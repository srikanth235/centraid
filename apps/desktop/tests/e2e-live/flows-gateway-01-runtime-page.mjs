#!/usr/bin/env node
// Gateway runtime page E2E against the REAL desktop app — real embedded
// gateway, real heartbeat monitor, no mocks. Run with:
//   node apps/desktop/tests/e2e-live/flows-gateway-01-runtime-page.mjs
// (prereq: `bun run build --filter=@centraid/desktop` from repo root)
//
// Path: launch → sidebar shows the live heartbeat pill → Gateway page renders
// Operational with server uptime + heartbeat strip → the Alerts tab: change
// the down-alert threshold (persists to centraid-settings.json) → toggle
// alerts off/on → the Backup card on Overview reports "not configured" (the
// desktop's embedded local gateway never wires a `backup` block — see the
// NEEDS-WIRING note at the bottom of this file) → switch to a FLAKY remote
// gateway (issue #351 wave 4: a real HTTP server this script controls,
// closed at first so the monitor logs a real 'down' transition, then opened
// so the SAME tracked gateway recovers — a plain "dead forever" gateway
// can't exercise 'recovered', and switching gateways resets tracking so
// switching back to local wouldn't either, see gateway-monitor.ts's file
// header) → Overview flips to Unreachable and opens an ongoing outage → the
// Alerts tab's persisted "Alert history" panel shows the down event → the
// flaky server comes up → Overview recovers to Operational → Alert history
// shows the recovered event too → switch back to local → CLOSE the app and
// relaunch against the SAME userData dir → the down/recovered history is
// still there, now marked "earlier session".
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/**
 * A remote gateway this script fully controls: starts CLOSED (nothing
 * listening — connections refuse, exactly like a real dead VPS) so the
 * monitor's probe fails and logs a 'down' transition, then `goUp()` starts
 * a real HTTP listener answering `/centraid/_gateway/health`, so the NEXT
 * poll (≤5s later) succeeds and the SAME tracked gateway recovers.
 */
function makeFlakyGateway() {
  const server = http.createServer((req, res) => {
    if (req.url === '/centraid/_gateway/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          startedAt: new Date().toISOString(),
          uptimeMs: 1000,
          components: [],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let port;
  return {
    /** Reserve a port WITHOUT listening yet — connections to it refuse. */
    async reservePort() {
      const probe = http.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      return port;
    },
    async goUp() {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    async close() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'userdata-gw01');
  await fs.rm(userDataDir, { recursive: true, force: true });
  const flaky = makeFlakyGateway();
  let session = await launchApp({ userDataDir });
  let { page } = session;
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
    assert(
      heroText.includes('local gateway'),
      `hero names the local gateway: ${heroText.slice(0, 200)}`,
    );
    assert(/Gateway uptime/i.test(heroText), 'uptime figure present');
    assert(/Availability/i.test(heroText), 'availability figure present');
    const beats = await page.locator('[data-ok]').count();
    assert(beats >= 1, `heartbeat strip has ticks (got ${beats})`);
    assert(heroText.includes('100.0%'), `availability reads 100.0%: ${heroText.slice(0, 300)}`);
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-1-operational.png') });
    console.log(`[gw01] Operational hero + ${beats} heartbeat ticks`);

    // 2b — the recovery-kit gate (issue #351 wave 4): the desktop's embedded
    // local gateway never wires a `backup` config block (see the
    // NEEDS-WIRING note at the bottom of this file), so the Backup card
    // reads "not configured" and — since there's no keyring to have
    // exported a kit from — withholds the "I've saved my recovery kit"
    // button. This is the honestly-reachable slice of the gate from inside
    // the real app; the confirm round-trip itself is covered for real
    // (real HTTP server, real BackupService, survives a restart) by
    // packages/gateway/src/serve/serve.test.ts's
    // "recoveryKit confirmation survives a restart" case.
    await page.getByText('Backups aren’t set up for this gateway').waitFor({
      state: 'visible',
      timeout: 15_000,
    });
    const confirmBtnCount = await page
      .getByRole('button', { name: "I've saved my recovery kit" })
      .count();
    assert(confirmBtnCount === 0, 'confirm button withheld when backup is not configured');
    console.log('[gw01] Backup card: not configured, recovery-kit confirm button withheld');

    // 3 — the down-alert card lives under its own Alerts tab now.
    await page.getByRole('tab', { name: 'Alerts', exact: true }).click();
    await page
      .getByText('Down alert', { exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });

    // the down-alert default is 2m; move it to 5m and confirm it persists.
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
    await page.getByRole('switch').first().click();
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false',
      { timeout: 15_000 },
    );
    const settingsOff = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'centraid-settings.json'), 'utf8'),
    );
    assert(settingsOff.gatewayAlertsEnabled === false, 'alerts-off persisted');
    await page.getByRole('switch').first().click(); // back on
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-2-alert-card.png') });
    console.log('[gw01] alert toggle round-trips through settings');

    // Alert history starts empty this launch.
    await page
      .getByText('No alerts recorded yet', { exact: false })
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[gw01] Alert history starts empty');

    // 5 — point the app at the flaky gateway WHILE IT'S STILL CLOSED: the
    // monitor's probe fails immediately (connection refused), so it flips
    // to Unreachable and opens a real, durable outage (issue #351 wave 4).
    const flakyPort = await flaky.reservePort();
    await page.evaluate(async (url) => {
      const profile = await window.CentraidApi.addGateway({
        label: 'Flaky Gateway',
        url,
        token: 'flaky-token',
      });
      await window.CentraidApi.setActiveGateway({ id: profile.id });
    }, flaky.url);
    // Gateway switch bounces the shell home; navigate back to the page.
    await page
      .getByRole('button', { name: /^Gateway/ })
      .first()
      .click();
    await page
      .getByText('Unreachable', { exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('— ongoing').waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .getByRole('button', { name: 'Gateway down', exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-3-unreachable.png') });
    console.log('[gw01] flaky gateway (closed) → Unreachable + ongoing outage + red sidebar pill');

    // 6 — the durable Alert history (Alerts tab) picks up the down event —
    // independent of the OS-alert threshold above (5m), so it shows up
    // immediately, not after 5 minutes. Scoped to the panel's own rows
    // (data-testid) rather than a bare text match — "Gateway down" also
    // appears as the sidebar pill's accessible name.
    await page.getByRole('tab', { name: 'Alerts', exact: true }).click();
    const alertHistoryPanel = page.getByTestId('alert-history-panel');
    await alertHistoryPanel.waitFor({ state: 'visible', timeout: 10_000 });
    await alertHistoryPanel
      .getByTestId('alert-history-row')
      .filter({ hasText: 'Gateway down' })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-4-alert-history-down.png') });
    console.log('[gw01] Alert history shows a persisted "Gateway down" entry');

    // 7 — bring the flaky gateway UP. Same tracked gatewayId the whole
    // time (no switch), so the next successful poll (≤5s) logs a real
    // 'recovered' event with the outage duration. Still on the Alerts tab
    // from step 6 (no navigation happened, so the tab's local state didn't
    // reset) — hop back to Overview explicitly to see "Operational".
    await flaky.goUp();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 30_000 });
    console.log('[gw01] flaky gateway came up → Operational again');

    await page.getByRole('tab', { name: 'Alerts', exact: true }).click();
    await alertHistoryPanel
      .getByTestId('alert-history-row')
      .filter({ hasText: 'Recovered' })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-5-alert-history-recovered.png') });
    console.log('[gw01] Alert history shows a persisted "Recovered" entry');

    // 8 — switch back to local: tracking re-keys and recovers to Operational.
    await page.evaluate(async () => {
      await window.CentraidApi.setActiveGateway({ id: 'local' });
    });
    await page
      .getByRole('button', { name: /^Gateway/ })
      .first()
      .click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-6-recovered-local.png') });
    console.log('[gw01] back on local → Operational again');

    // 9 — RELAUNCH against the SAME userData dir (issue #351 wave 4's core
    // claim: outage history survives a restart). Close this instance,
    // tear down the flaky server (nothing should still be probing it —
    // we're back on local), and launch fresh.
    await session.close();
    await flaky.close();
    console.log('[gw01] closed — relaunching against the same userData dir');
    session = await launchApp({ userDataDir });
    page = session.page;
    await page.setViewportSize({ width: 1400, height: 900 });

    await page
      .getByRole('button', { name: /^Gateway/ })
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page
      .getByRole('button', { name: /^Gateway/ })
      .first()
      .click();
    await page.getByText('Operational').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('tab', { name: 'Alerts', exact: true }).click();
    const alertHistoryPanelAfter = page.getByTestId('alert-history-panel');
    await alertHistoryPanelAfter.waitFor({ state: 'visible', timeout: 10_000 });

    // Both events from the PREVIOUS launch are still there…
    await alertHistoryPanelAfter
      .getByTestId('alert-history-row')
      .filter({ hasText: 'Gateway down' })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await alertHistoryPanelAfter
      .getByTestId('alert-history-row')
      .filter({ hasText: 'Recovered' })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    // …and both are marked as predating this launch.
    const earlierSessionBadges = await alertHistoryPanelAfter
      .getByText('earlier session', { exact: true })
      .count();
    assert(
      earlierSessionBadges >= 2,
      `both persisted entries marked "earlier session" (got ${earlierSessionBadges})`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-7-history-after-relaunch.png') });
    console.log(
      `[gw01] Alert history survived the relaunch — ${earlierSessionBadges} "earlier session" entries`,
    );

    console.log('[gw01] PASS');
  } catch (err) {
    await page.screenshot({ path: path.join(OUT_DIR, 'gw01-FAIL.png') }).catch(() => undefined);
    throw err;
  } finally {
    await session.close();
    await flaky.close();
  }
}

main().catch((err) => {
  console.error('[gw01] FAIL:', err);
  process.exit(1);
});

// NEEDS-WIRING (out of scope for this wave — flagging, not building):
// the desktop's embedded local gateway (apps/desktop/src/main/local-gateway.ts)
// never passes a `backup` block to `serve()`, so `BackupService` never
// constructs for it and `/centraid/_gateway/backup` always answers
// `{configured: false, ...}` in the real app. That means the recovery-kit
// CONFIRM round-trip (the "I've saved my recovery kit" button actually
// POSTing) can't be exercised through this real-Electron rig today — only
// the "not configured, button withheld" half of the gate is reachable here.
// The confirm→persist→survives-a-restart contract IS verified for real,
// just one layer down (real HTTP server + real BackupService, no Electron
// chrome) in packages/gateway/src/serve/serve.test.ts. Wiring a default
// local-backup provider dir into the desktop's embedded gateway (so this
// rig could exercise the button too) is a real product decision — where
// snapshots land on disk, whether it's on by default — that belongs to a
// future issue, not this one.

#!/usr/bin/env node
// Shell QA v2 Suite 6 (issue #382): ConnectFlow's "Existing gateway" ->
// "Connect by URL" advanced path, for real. A real SECOND `centraid-gateway
// serve` process stands in for a landlord/admin-reachable gateway (the
// design doc's URL+token use case — Tailscale/reverse-proxy setups that
// skip iroh discovery). Drives the handshake ladder against a WRONG port
// first (must fail at "reach" with an actionable message), then the real
// url + the gateway's own admin bearer token (print-token output) — must
// pass reach/identify/auth/vaults and complete the connect.
//
// Run with: node tests/e2e-live/flows-shell-v2-06-url-connect.mjs  (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GATEWAY_CLI = path.join(REPO_ROOT, 'packages', 'gateway', 'dist', 'cli', 'cli.js');
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-v2-06');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
let secondGateway;

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
      await page.screenshot({ path: path.join(OUT_DIR, `06-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `06-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function startSecondGateway(dataDir) {
  const child = spawn(
    process.execPath,
    [GATEWAY_CLI, 'serve', '--data-dir', dataDir, '--host', '127.0.0.1', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (/listening on/.test(stdout) && /token:/.test(stdout)) break;
    if (child.exitCode !== null) {
      throw new Error(`second gateway exited early (code ${child.exitCode}): ${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const urlMatch = /listening on (\S+)/.exec(stdout);
  const tokenMatch = /token: (\S+)/.exec(stdout);
  assert(urlMatch, `second gateway never printed its listening URL: ${stdout}`);
  assert(tokenMatch, `second gateway never printed its admin token: ${stdout}`);
  console.log(`[v2-06] second gateway up: url=${urlMatch[1]}`);
  return { child, url: urlMatch[1], token: tokenMatch[1], dataDir };
}

/** A definitely-wrong port on the same loopback host — the gateway itself
 *  bound an ephemeral port, so this just needs to not be that port. Port 1
 *  is a reserved low port no unprivileged process can bind, i.e. always
 *  closed on a dev machine. */
function wrongPortUrl(realUrl) {
  const u = new URL(realUrl);
  u.port = '1';
  return u.toString();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });

  const secondDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-url-remote-'));
  secondGateway = await startSecondGateway(secondDataDir);

  try {
    session = await launchApp({ userDataDir: USER_DATA_DIR });
    page = session.page;
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'url-connect-wrong-port-fails',
      'Connect by URL with a WRONG port fails the handshake ladder at "reach" with an actionable message',
      async () => {
        await page.getByRole('button', { name: /Active space:/ }).click();
        await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
        await page.getByRole('button', { name: 'Add gateway…' }).click();
        const modal = page.getByRole('dialog').filter({ hasText: 'Add gateway' });
        await modal.waitFor({ state: 'visible', timeout: 10_000 });

        const gatewayCard = page.getByRole('radio', { name: /^Existing gateway/ });
        await gatewayCard.click();
        await page.waitForTimeout(300);

        const advanced = page.locator('summary', { hasText: 'Connect by URL' });
        await advanced.click();
        await page.waitForTimeout(200);
        await shot('01-advanced-url-open');

        await page.getByRole('radio', { name: 'Bearer token' }).click();
        const badUrl = wrongPortUrl(secondGateway.url);
        await page.getByLabel('Gateway URL').fill(badUrl);
        await page.getByLabel('Bearer token').fill(secondGateway.token);
        await page.waitForTimeout(200);
        await shot('02-wrong-port-filled');

        const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
        assert(
          !(await continueBtn.isDisabled()),
          'Continue should enable once url+token are filled',
        );
        await continueBtn.click();

        // "reach" should fail promptly (connection refused) — this doesn't
        // need the long SSH-style poll (no subprocess spawns involved).
        const retryBtn = page.getByRole('button', { name: 'Retry', exact: true });
        await retryBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await shot('03-wrong-port-ladder-failed');
        const bodyText = await page.locator('body').textContent();
        console.log(`[v2-06] wrong-port ladder state: ${JSON.stringify(bodyText.slice(0, 500))}`);

        const summary = page.locator('[class*="testSummary"]');
        const summaryText = await summary.textContent().catch(() => '');
        console.log(`[v2-06] wrong-port summary: ${JSON.stringify(summaryText)}`);
        assert(
          summaryText.trim().length > 0,
          'no actionable summary shown for the failed reach stage',
        );
        // The "reach" stage itself must be the one marked failed, not e.g.
        // silently skipped past — HandshakeLadder renders each stage's
        // status as a data attribute (see HandshakeLadder.tsx).
        const failedStage = page.locator('[data-status="fail"]').first();
        assert(
          await failedStage.isVisible().catch(() => false),
          'no stage rendered with data-status="fail"',
        );

        // Go back to fix the URL for the next step, rather than tearing
        // down the whole modal. Scoped to the modal — the chrome nav also
        // has an (unrelated, disabled) "Back" button.
        await modal.getByRole('button', { name: 'Back', exact: true }).click();
        await page.waitForTimeout(300);
      },
    );

    await step(
      'url-connect-correct-passes-and-completes',
      'Correct URL + bearer token passes reach/identify/auth/vaults and completes the connect',
      async () => {
        const urlField = page.getByLabel('Gateway URL');
        await urlField.fill('');
        await urlField.fill(secondGateway.url);
        await page.waitForTimeout(200);
        await shot('04-correct-url-filled');

        const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
        assert(
          !(await continueBtn.isDisabled()),
          'Continue should re-enable with a valid url+token',
        );
        await continueBtn.click();

        const proceedBtn = page.getByRole('button', { name: 'Continue', exact: true });
        await proceedBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(300);
        await shot('05-correct-url-ladder-passed');
        const bodyText = await page.locator('body').textContent();
        console.log(`[v2-06] correct-url ladder state: ${JSON.stringify(bodyText.slice(0, 600))}`);

        const retryVisible = await page
          .getByRole('button', { name: 'Retry', exact: true })
          .isVisible()
          .catch(() => false);
        assert(!retryVisible, 'handshake ladder still failing against the CORRECT url+token');
        assert(!(await proceedBtn.isDisabled()), 'Continue (to vault step) should be enabled');
        await proceedBtn.click();
        await page.waitForTimeout(500);
        await shot('06-vault-step-token-mode');

        // Design doc step C: a url+token gateway's admin plane can only
        // BROWSE vaults (create-new unavailable) — the second gateway's own
        // default vault ("Owner's vault") must be selectable.
        const createRadioCount = await page
          .getByRole('radio', { name: /Create new space/ })
          .count();
        assert(
          createRadioCount === 0,
          'url+token ConnectFlow offered "Create new space" — design doc says create is unavailable for this method',
        );
        const existingVaultRadio = page.getByRole('radio', { name: /vault/i }).first();
        await existingVaultRadio.waitFor({ state: 'visible', timeout: 10_000 });
        await existingVaultRadio.click();
        await page.waitForTimeout(200);

        const connectBtn = page.getByRole('button', { name: 'Connect', exact: true });
        assert(
          !(await connectBtn.isDisabled()),
          'Connect should be enabled once a vault is picked',
        );
        await connectBtn.click();
        await page.waitForTimeout(1_500);
        await shot('07-after-connect');

        const stillOpenModal = await page
          .getByRole('dialog')
          .filter({ hasText: 'Add gateway' })
          .isVisible()
          .catch(() => false);
        if (stillOpenModal) {
          const errText = await page.locator('body').textContent();
          throw new Error(
            `ConnectFlow modal still open after Connect — error state? ${errText.slice(0, 1000)}`,
          );
        }

        await page.getByRole('button', { name: /Active space:/ }).click();
        await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
        await page.waitForTimeout(500);
        await shot('08-switcher-after-url-connect');
        const menuText = await page.getByRole('menu').first().textContent();
        console.log(`[v2-06] switcher after url+token connect: ${JSON.stringify(menuText)}`);
        assert(/SPACES\s*·\s*2/.test(menuText), 'switcher does not report 2 total spaces');
        assert(
          /URL/.test(menuText),
          'switcher does not show the URL transport badge for a direct-url gateway',
        );
        // The url+token gateway is admin-plane-only — its header must NOT
        // offer "+New space" (design doc: canCreateVault = local || hasSsh).
        // aria-label is "New space on <gatewayLabel>" (vaultSwitcher.ts) —
        // an icon-only button with no visible text content, so match by
        // accessible name (not a text-content filter, which would silently
        // match the Local group's own icon-only button too — an aria-label
        // has no textContent for `hasText`/`hasNotText` to see).
        const newSpaceOnUrlGateway = page.getByRole('button', {
          name: `New space on ${secondGateway.url}`,
        });
        assert(
          (await newSpaceOnUrlGateway.count()) === 0,
          'url+token gateway offers "+New space" in the switcher — should be admin-plane read-only',
        );
        await page.keyboard.press('Escape');
      },
    );

    // ---- Report ----
    console.log('\n================ URL CONNECT VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(38)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=============================================================');
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll URL connect steps PASSED.');
    }
  } finally {
    if (session) await session.close().catch(() => undefined);
    secondGateway?.child.kill('SIGTERM');
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(secondDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

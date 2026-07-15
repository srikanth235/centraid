#!/usr/bin/env node
// Shell QA v2 Suite 5 (issue #382): the "Over SSH" ConnectFlow path,
// end-to-end, for real. This is the one integration surface the two
// concurrent agents (backend: apps/desktop/src/main/ssh-host.ts +
// gateway-ssh-connect.ts; renderer: ConnectFlow.tsx) never got to exercise
// together before this suite.
//
// Real SECOND `centraid-gateway serve` process on the host (its own temp
// data-dir, ephemeral loopback port + iroh endpoint) stands in for "the
// remote box". `CENTRAID_SSH_BIN` points the Electron app's ssh-host.ts at
// a stub script that, instead of actually SSHing out, execs the exact same
// remote-CLI command LOCALLY against that second data-dir — the design
// doc's stated E2E approach ("SSH support ... E2E via CENTRAID_SSH_BIN stub
// script that executes the 'remote' command against a second local
// daemon's data-dir"). The stub also puts a fake `centraid-gateway` shim
// first on PATH so `ssh-host-core.ts`'s DEFAULT_REMOTE_CLI ('centraid-
// gateway', a bare command name resolved by the remote shell) finds the
// real built CLI (packages/gateway/dist/cli/cli.js) without needing it
// installed as an actual global bin.
//
// Run with: node tests/e2e-live/flows-shell-v2-05-ssh-connect.mjs  (from apps/desktop)
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
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-v2-05');

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
      await page.screenshot({ path: path.join(OUT_DIR, `05-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `05-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

/** Start the "remote" gateway — a real `centraid-gateway serve` process,
 *  its own data-dir, ephemeral loopback port. Resolves once its iroh
 *  endpoint has minted (stdout prints "endpoint: <id>") — `pair` (used by
 *  the SSH commit step) reads that identity straight off disk and fails
 *  loudly if it was never written (see device-admin.ts#readEndpointState). */
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
    if (/endpoint: /.test(stdout) && /listening on/.test(stdout)) break;
    if (child.exitCode !== null) {
      throw new Error(`second gateway exited early (code ${child.exitCode}): ${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const urlMatch = /listening on (\S+)/.exec(stdout);
  const tokenMatch = /token: (\S+)/.exec(stdout);
  const endpointMatch = /endpoint: (\S+)/.exec(stdout);
  assert(urlMatch, `second gateway never printed its listening URL: ${stdout}`);
  assert(endpointMatch, `second gateway never printed its iroh endpoint id: ${stdout}`);
  console.log(
    `[v2-05] second gateway up: url=${urlMatch[1]} endpoint=${endpointMatch[1].slice(0, 16)}…`,
  );
  return {
    child,
    url: urlMatch[1],
    token: tokenMatch?.[1],
    endpointId: endpointMatch[1],
    dataDir,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Write the CENTRAID_SSH_BIN stub + its `centraid-gateway` PATH shim into
 *  `dir`. Returns the absolute path to the stub script (the SSH binary
 *  override) and the bin dir (PATH prefix) the stub injects. */
async function writeSshStub(dir) {
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const shimPath = path.join(binDir, 'centraid-gateway');
  await fs.writeFile(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${GATEWAY_CLI}" "$@"\n`, {
    mode: 0o755,
  });

  // ssh-host.ts's buildSshArgv (ssh-host-core.ts) produces:
  //   ['-o','BatchMode=yes','-o','ConnectTimeout=8',
  //    '-o','StrictHostKeyChecking=accept-new', destination, '--', cmdString]
  // where cmdString is the whole remote argv, already shell-quoted, joined
  // into ONE argv element. This stub ignores everything but that last
  // element and runs it through a real shell (so the quoting round-trips),
  // with `binDir` prepended to PATH so the bare `centraid-gateway` command
  // name resolves to the shim above instead of "command not found".
  const stubPath = path.join(dir, 'ssh-stub.mjs');
  await fs.writeFile(
    stubPath,
    [
      '#!/usr/bin/env node',
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      "const cmd = args[args.length - 1] ?? '';",
      "const binDir = process.env.CENTRAID_SSH_STUB_BIN_DIR ?? '';",
      "const env = { ...process.env, PATH: binDir + ':' + (process.env.PATH ?? '') };",
      "const res = spawnSync('/bin/sh', ['-c', cmd], { stdio: 'inherit', env });",
      'process.exit(res.status ?? 1);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { stubPath, binDir };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });

  const secondDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-ssh-remote-'));
  const stubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-ssh-stub-'));

  secondGateway = await startSecondGateway(secondDataDir);
  const { stubPath, binDir } = await writeSshStub(stubDir);

  let session2Present = false;
  try {
    session = await launchApp({
      userDataDir: USER_DATA_DIR,
      env: {
        CENTRAID_SSH_BIN: stubPath,
        CENTRAID_SSH_STUB_BIN_DIR: binDir,
      },
    });
    page = session.page;
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'ssh-connect-flow',
      'Switcher -> Add gateway -> Over SSH -> handshake ladder passes -> create space -> Connect',
      async () => {
        await page.getByRole('button', { name: /Active space:/ }).click();
        await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
        await page.getByRole('button', { name: 'Add gateway…' }).click();
        // ConnectFlowModal's dialog has no aria-label/aria-labelledby (just
        // an <h2>), so its accessible name doesn't resolve to "Add gateway"
        // for role-based matching — scope by content instead.
        const modal = page.getByRole('dialog').filter({ hasText: 'Add gateway' });
        await modal.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('01-add-gateway-modal');

        const sshCard = page.getByRole('radio', { name: /Over SSH/ });
        await sshCard.waitFor({ state: 'visible', timeout: 5_000 });
        await sshCard.click();
        await page.waitForTimeout(300);
        await shot('02-ssh-details-form');

        await page.getByLabel('Destination').fill('test@localhost');
        await page.getByLabel(/Remote data directory/).fill(secondDataDir);
        await page.getByLabel(/^Label/).fill('QA SSH Box');

        const continueBtn = page.getByRole('button', { name: 'Continue' });
        assert(!(await continueBtn.isDisabled()), 'Continue should enable once destination is set');
        await continueBtn.click();

        // Handshake ladder: ssh -> cli -> daemon -> vaults, all real (the
        // stub only swaps the transport, every command genuinely runs — 4
        // sequential `spawn()`s of a cold node process each, so this is
        // slower than the in-process HTTP handshake — poll rather than a
        // fixed sleep).
        const retryBtn = page.getByRole('button', { name: 'Retry', exact: true });
        const proceedBtn = page.getByRole('button', { name: 'Continue', exact: true });
        const settleDeadline = Date.now() + 30_000;
        let settled = false;
        while (Date.now() < settleDeadline) {
          if (await retryBtn.isVisible().catch(() => false)) {
            settled = true;
            break;
          }
          if (
            (await proceedBtn.isVisible().catch(() => false)) &&
            !(await proceedBtn.isDisabled().catch(() => true))
          ) {
            settled = true;
            break;
          }
          await page.waitForTimeout(300);
        }
        assert(settled, 'handshake ladder never settled (still "Checking…" after 30s)');
        // Let the ~80ms-staggered stage-reveal CSS animation finish so the
        // screenshot shows all 4 stages, not just whichever had painted the
        // instant the poll loop above noticed the Continue button enable.
        await page.waitForTimeout(500);
        await shot('03-handshake-ladder');
        const bodyText = await page.locator('body').textContent();
        console.log(`[v2-05] handshake ladder state: ${JSON.stringify(bodyText.slice(0, 600))}`);

        const summary = page.locator('[class*="testSummary"]');
        const summaryVisible = await summary.isVisible().catch(() => false);
        if (summaryVisible) {
          console.log(`[v2-05] test summary: ${await summary.textContent()}`);
        }

        // If a stage failed, the retry button reads "Retry"; on success the
        // step's continue button reads "Continue" and is enabled.
        if (await retryBtn.isVisible().catch(() => false)) {
          throw new Error(
            `SSH handshake ladder reported a failure — see screenshot + summary above. ` +
              `Second gateway stderr tail: ${secondGateway.stderr().slice(-2000)}`,
          );
        }

        await proceedBtn.waitFor({ state: 'visible', timeout: 5_000 });
        assert(!(await proceedBtn.isDisabled()), 'Continue (to vault step) should be enabled');
        await proceedBtn.click();
        await page.waitForTimeout(500);
        await shot('04-vault-step');

        // Vault step: ssh-capable gateways can create a new space directly
        // (design doc step C — "ssh: vault create --json remotely, then
        // enroll this device into it").
        const createRadio = page.getByRole('radio', { name: /Create new space/ });
        await createRadio.waitFor({ state: 'visible', timeout: 10_000 });
        await createRadio.click();
        await page.getByPlaceholder('Space name').fill('SSH Space');
        await page.waitForTimeout(200);
        await shot('05-vault-step-create-filled');

        const connectBtn = page.getByRole('button', { name: 'Connect', exact: true });
        assert(
          !(await connectBtn.isDisabled()),
          'Connect should be enabled with a space name typed',
        );
        await connectBtn.click();

        await page.waitForTimeout(2_000);
        await shot('06-after-connect');

        const stillOpenModal = await page
          .getByRole('dialog', { name: 'Add gateway' })
          .isVisible()
          .catch(() => false);
        if (stillOpenModal) {
          const errText = await page.locator('body').textContent();
          throw new Error(
            `ConnectFlow modal still open after Connect — error state? ${errText.slice(0, 1000)}`,
          );
        }

        // Success toast + the switcher now lists 2 gateways, the SSH one
        // active with its new vault.
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: /Active space:/ }).click();
        await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
        await page.waitForTimeout(600); // let stale-while-revalidate fill in
        await shot('07-switcher-two-gateways');
        const menuText = await page.getByRole('menu').first().textContent();
        console.log(`[v2-05] switcher after SSH connect: ${JSON.stringify(menuText)}`);
        assert(
          /SPACES\s*·\s*2/.test(menuText),
          'switcher does not report 2 total spaces (1 local + 1 ssh)',
        );
        assert(/Local/.test(menuText), 'switcher lost the local gateway group');
        assert(/SSH Space/.test(menuText), 'switcher does not list the SSH-created space');
        assert(/QA SSH Box/.test(menuText), 'switcher does not show the SSH gateway group label');
        // OBSERVATION (not asserted as a failure — see final report): the
        // transport badge reads "IROH", not "SSH". Every gateway connected
        // via redeemGatewayPairing (gateway-pairing.ts's addGateway call)
        // always writes `transport: 'iroh'` explicitly onto the profile —
        // including the ssh-bootstrap path, since day-to-day traffic to it
        // really does ride the iroh tunnel once connected (ssh is only used
        // for the one-time admin bootstrap + later "New space…"/"Test
        // connection" acts). transportBadgeFor's `hasSsh && transport ===
        // undefined -> 'SSH'` branch is therefore unreachable from the
        // actual product flow. Arguably correct (badge = ongoing transport,
        // not provenance) but worth a design call.
        console.log(
          `[v2-05] transport badge for the ssh-bootstrapped gateway: ${/IROH/.test(menuText) ? 'IROH' : /SSH/.test(menuText) ? 'SSH' : '<neither>'}`,
        );

        // The ssh-capable gateway's "+New space" header action must be
        // offered (design doc step C: local/ssh gateways admin their own
        // vault lifecycle) — canCreateVault gates on `hasSsh`, independent
        // of the transport badge text above.
        const newSpaceOnSsh = page.getByRole('button', { name: 'New space on QA SSH Box' });
        assert(
          await newSpaceOnSsh.isVisible().catch(() => false),
          '"+New space" action missing on the ssh-capable gateway\'s header row',
        );

        await page.keyboard.press('Escape');
        session2Present = true;
      },
    );

    if (session2Present) {
      await step(
        'ssh-gateway-active-and-usable',
        'The SSH-connected gateway is now active; Home renders its (empty) space',
        async () => {
          await page
            .getByRole('heading', { name: 'What should we build?' })
            .waitFor({ state: 'visible', timeout: 15_000 });
          const bodyText = await page.locator('body').textContent();
          assert(/SSH Space/.test(bodyText), 'sidebar head does not show the SSH space as active');
          await shot('08-home-on-ssh-gateway');
        },
      );
    }

    // ---- Report ----
    console.log('\n================ SSH CONNECT VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=============================================================');
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll SSH connect steps PASSED.');
    }
  } finally {
    if (session) await session.close().catch(() => undefined);
    secondGateway?.child.kill('SIGTERM');
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(secondDataDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(stubDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

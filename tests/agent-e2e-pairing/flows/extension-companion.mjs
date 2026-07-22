import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { runFlow } from '../lib/harness.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extensionDir = path.join(repo, 'apps/extension/dist');

async function run(command, args) {
  const child = spawn(command, args, { cwd: repo, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

await run('bun', ['run', '--cwd', 'apps/extension', 'build']);

const loginServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>Companion acceptance</title>
    <form><label>Email <input autocomplete="username" name="email"></label>
    <label>Password <input type="password" autocomplete="current-password" name="password"></label>
    <label>Code <input autocomplete="one-time-code" name="otp"></label>
    <button>Sign in</button></form>`);
});
await new Promise((resolve) => loginServer.listen(0, '127.0.0.1', resolve));
const address = loginServer.address();
if (!address || typeof address === 'string') throw new Error('login server did not bind');
const loginUrl = `http://localhost:${address.port}/login`;

try {
  await runFlow('extension-companion', async (ctx) => {
    const created = JSON.parse(
      (await ctx.cli(['vault', 'create', '--name', 'CompanionE2E'])).stdout
        .trim()
        .split('\n')
        .at(-1),
    );
    const vaultId = created.vaultId;
    if (!vaultId) throw new Error('vault create returned no vault id');
    const headers = {
      authorization: `Bearer ${ctx.gateway.token}`,
      'content-type': 'application/json',
      'x-centraid-vault': vaultId,
    };
    const install = await fetch(`${ctx.gateway.url}/centraid/_apps/_install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ templateId: 'locker' }),
    });
    if (!install.ok)
      throw new Error(`Locker install failed: ${install.status} ${await install.text()}`);
    const add = await fetch(`${ctx.gateway.url}/centraid/_tool/centraid_write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app: 'locker',
        action: 'add-item',
        intentId: crypto.randomUUID(),
        input: {
          type: 'login',
          title: 'Companion acceptance',
          username: 'owner@example.test',
          password: 'Correct-Horse-462!',
          otp_seed: 'JBSWY3DPEHPK3PXP',
          url: loginUrl,
          url_match_policy: 'exact-host',
        },
      }),
    });
    if (!add.ok) throw new Error(`Locker seed failed: ${add.status} ${await add.text()}`);

    const { raw: ticket } = await ctx.mintTicket({ vault: 'CompanionE2E' });
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const extensionId = new URL(worker.url()).host;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.getByLabel('Pairing code').fill(ticket);
      await page.getByRole('button', { name: 'Pair device' }).click();
      await page.getByText('Paired gateway').waitFor({ timeout: 30_000 });
      const pairing = await worker.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        return all['centraid.companion.v1.pairing'];
      });
      if (!pairing?.endpointId) throw new Error('extension stored no paired endpoint identity');
      ctx.note(`MV3 worker paired endpoint ${pairing.endpointId.slice(0, 10)}… over browser iroh`);

      await page.goto(loginUrl);
      const trigger = page.getByRole('button', { name: 'Centraid' });
      await trigger.waitFor({ timeout: 15_000 });
      await trigger.click();
      const choice = page.getByRole('button', { name: /Companion acceptance/ });
      await choice.waitFor({ timeout: 15_000 });
      const coldStart = performance.now();
      await choice.click();
      await page.locator('input[name="password"]').waitFor();
      await page.waitForFunction(
        () => document.querySelector('input[name="password"]')?.value === 'Correct-Horse-462!',
      );
      const coldMs = performance.now() - coldStart;
      if (coldMs > 2_000) throw new Error(`cold fill exceeded 2s budget: ${Math.round(coldMs)}ms`);
      if ((await page.locator('input[name="email"]').inputValue()) !== 'owner@example.test')
        throw new Error('username was not filled');
      if (!/^\d{6}$/.test(await page.locator('input[name="otp"]').inputValue()))
        throw new Error('derived TOTP was not filled');

      await page.reload();
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();
      await choice.waitFor({ timeout: 10_000 });
      const warmStart = performance.now();
      await choice.click();
      await page.waitForFunction(
        () => document.querySelector('input[name="password"]')?.value === 'Correct-Horse-462!',
      );
      const warmMs = performance.now() - warmStart;
      if (warmMs > 500) throw new Error(`warm fill exceeded 500ms budget: ${Math.round(warmMs)}ms`);
      ctx.note(`fill budgets held: cold ${Math.round(coldMs)}ms, warm ${Math.round(warmMs)}ms`);

      const review = await fetch(`${ctx.gateway.url}/centraid/_vault/review?limit=20`, { headers });
      const entries = (await review.json()).entries ?? [];
      if (
        !entries.some(
          (entry) =>
            entry.action === 'reveal' && entry.context?.origin === new URL(loginUrl).origin,
        )
      ) {
        throw new Error(`review feed has no fill reveal for ${loginUrl}`);
      }
      ctx.note('origin-bearing Locker reveal is visible in the owner review feed');

      await ctx.cli(['devices', 'revoke', pairing.endpointId]);
      await page.reload();
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();
      await page
        .getByText(/revoked|Pair this browser/i)
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined);
      const pairingAfter = await worker.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        return all['centraid.companion.v1.pairing'];
      });
      if (pairingAfter) throw new Error('remote revocation did not purge extension pairing state');
      if (await page.locator('input[name="password"]').inputValue())
        throw new Error('revoked fill still populated password');
      ctx.note('remote revocation killed the next fill and purged local pairing state');
    } finally {
      await context.close();
    }
    return { pass: true, notes: 'real MV3 pair → cold/warm fill → receipt → revoke journey held' };
  });
} finally {
  await new Promise((resolve) => loginServer.close(resolve));
}

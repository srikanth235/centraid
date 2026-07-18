import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * (gateway, vault) addressing over HTTP (issue #289).
 *
 * Proves the landlord model end-to-end against a real `serve()` daemon:
 *
 *   1. Two vaults on one gateway hold DISJOINT app worlds; the
 *      `x-centraid-vault` header addresses one per request, concurrently,
 *      with no server-side switch.
 *   2. An unknown vault header fails loudly (404), never falls back.
 *   3. A device-scoped transport (deviceAccess) is confined to its
 *      enrollments: implied vault with no header, 403 outside it, and a
 *      vault list that shows no evidence of the others.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorktreeStore } from '../worktree-store/index.js';
import { serve, type GatewayServeHandle } from './serve.ts';
import { runWithVaultContext } from './vault-context.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;
let vaultA: string;
let vaultB: string;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const session = await store.openSession(`seed-${appId}`);
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({ manifestVersion: 1, id: appId, name: appId, version: '0.1.0' }),
  );
  await fs.writeFile(path.join(appDir, 'index.html'), `<!doctype html><title>${appId}</title>`);
  await store.publish({ sessionId: `seed-${appId}`, appId, message: 'seed' });
  await store.closeSession(`seed-${appId}`);
}

const DEVICE_HEADER = 'x-test-device';

beforeEach(async () => {
  dataDir = await tempDir(`addr-gateway-${crypto.randomUUID()}-`);
  handle = await serve({
    paths: pathsUnder(dataDir),
    // A fake device transport: the test names its device in a header the
    // way the iroh forwarder stamps the QUIC-proved EndpointId.
    deviceAccess: {
      deviceKeyFor: (req) => {
        const v = req.headers[DEVICE_HEADER];
        return typeof v === 'string' ? v : undefined;
      },
      vaultsFor: (deviceKey) => (deviceKey === 'family-phone' ? [vaultB] : []),
    },
  });
  vaultA = handle.vaults.defaultVaultId();
  vaultB = handle.vaults.create('Family').vaultId;

  // Seed one app into EACH vault's own code store, out of band.
  await seedApp(await handle.appsStore(), 'app-a');
  await handle.syncApps(vaultA);
  await runWithVaultContext({ vaultId: vaultB }, async () => {
    await seedApp(await handle.appsStore(), 'app-b');
  });
  await handle.syncApps(vaultB);
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

function get(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${handle.url}${pathname}`, {
    headers: { Authorization: `Bearer ${handle.token}`, ...headers },
  });
}

test('two clients address two vaults concurrently — disjoint app worlds, no switch', async () => {
  const [aRes, bRes] = await Promise.all([
    get('/centraid/_apps', { 'x-centraid-vault': vaultA }),
    get('/centraid/_apps', { 'x-centraid-vault': vaultB }),
  ]);
  const aApps = (await aRes.json()) as Array<{ id: string }>;
  const bApps = (await bRes.json()) as Array<{ id: string }>;
  expect(aApps.map((a) => a.id)).toContain('app-a');
  expect(aApps.map((a) => a.id)).not.toContain('app-b');
  expect(bApps.map((a) => a.id)).toContain('app-b');
  expect(bApps.map((a) => a.id)).not.toContain('app-a');

  // Static serve resolves each vault's own live `main` worktree.
  const html = await get('/centraid/app-b/', { 'x-centraid-vault': vaultB });
  expect(html.status).toBe(200);
  expect(await html.text()).toMatch(/<title>app-b<\/title>/);

  // No header → the default vault; nothing changed server-side after B's requests.
  const defaulted = (await (await get('/centraid/_vault/status')).json()) as {
    vaultId: string;
  };
  expect(defaulted.vaultId).toBe(vaultA);
});

test('an unknown vault header fails loudly, never falls back', async () => {
  const res = await get('/centraid/_apps', { 'x-centraid-vault': 'nope' });
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: 'vault_not_found' });
});

test('a device is confined to its enrollments (issue #289 phase 2)', async () => {
  // Single enrollment: no header needed — the vault is implied by the key.
  const implied = (await (
    await get('/centraid/_vault/status', { [DEVICE_HEADER]: 'family-phone' })
  ).json()) as { vaultId: string };
  expect(implied.vaultId).toBe(vaultB);

  // Addressing a non-enrolled vault is a 403, not a fallback.
  const denied = await get('/centraid/_vault/status', {
    [DEVICE_HEADER]: 'family-phone',
    'x-centraid-vault': vaultA,
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: 'vault_not_enrolled' });

  // A device with no enrollments opens nothing.
  const stranger = await get('/centraid/_apps', { [DEVICE_HEADER]: 'stolen-laptop' });
  expect(stranger.status).toBe(403);
  expect(await stranger.json()).toMatchObject({ error: 'device_not_enrolled' });

  // The vault list shows the device ITS vaults — no evidence of others.
  const listed = (await (
    await get('/centraid/_vault/vaults', { [DEVICE_HEADER]: 'family-phone' })
  ).json()) as { vaults: Array<{ vaultId: string }> };
  expect(listed.vaults.map((v) => v.vaultId)).toEqual([vaultB]);

  // The shared-bearer transport (no device key) still sees everything.
  const all = (await (await get('/centraid/_vault/vaults')).json()) as {
    vaults: Array<{ vaultId: string }>;
  };
  expect(all.vaults.map((v) => v.vaultId).sort()).toEqual([vaultA, vaultB].sort());
});

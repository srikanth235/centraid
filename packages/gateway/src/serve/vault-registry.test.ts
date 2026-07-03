import { afterEach, expect, test } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultRegistry, VaultRegistryError, type VaultRegistry } from './vault-registry.js';
import { makeVaultRouteHandler } from '../routes/vault-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-registry-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openRegistry(rootDir: string): VaultRegistry {
  const registry = openVaultRegistry({ rootDir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  return registry;
}

test('a fresh root bootstraps one default vault, active, in its own directory', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const vaults = registry.list();
  expect(vaults).toHaveLength(1);
  expect(vaults[0]).toMatchObject({ active: true, name: "Priya's vault" });
  // Layout: <root>/<vaultId>/vault.db + the active pointer beside it.
  expect(existsSync(path.join(root, vaults[0]!.vaultId, 'vault.db'))).toBe(true);
  expect(existsSync(path.join(root, 'vaults.json'))).toBe(true);
});

test('create / rename / switch / delete — and the active vault is undeletable', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const first = registry.list()[0]!;

  const family = registry.create('Family');
  expect(family).toMatchObject({ name: 'Family', active: false });
  expect(registry.list()).toHaveLength(2);

  const renamed = registry.rename(family.vaultId, 'Sharma family');
  expect(renamed.name).toBe('Sharma family');
  expect(() => registry.rename(family.vaultId, '   ')).toThrow(VaultRegistryError);

  // The active vault is protected — so one vault always remains.
  expect(() => registry.delete(first.vaultId)).toThrow(VaultRegistryError);

  registry.setActive(family.vaultId);
  expect(registry.active().boot.vaultId).toBe(family.vaultId);

  registry.delete(first.vaultId);
  expect(registry.list()).toHaveLength(1);
  expect(existsSync(path.join(root, first.vaultId))).toBe(false);
  expect(registry.get(first.vaultId)).toBeUndefined();
});

test('the registry survives a restart: same vaults, same names, same active pointer', async () => {
  const root = await tempDir();
  const first = openVaultRegistry({ rootDir: root, logger: silentLogger, ownerName: 'Priya' });
  const work = first.create('Work');
  first.setActive(work.vaultId);
  const ids = first
    .list()
    .map((v) => v.vaultId)
    .sort();
  first.stop();

  const second = openRegistry(root);
  expect(
    second
      .list()
      .map((v) => v.vaultId)
      .sort(),
  ).toEqual(ids);
  expect(second.active().boot.vaultId).toBe(work.vaultId);
  expect(second.active().name).toBe('Work');
  expect(second.active().boot.fresh).toBe(false);
});

test('ctx.vault follows the active vault; grants stay per vault', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const personal = registry.list()[0]!;
  registry.enrollApp('planner');
  registry.active().approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });

  const bridge = registry.bridgeFor('planner');
  const readReq = {
    op: 'read' as const,
    payload: { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  };
  const allowed = await bridge(readReq);
  expect(allowed.ok).toBe(true);

  // Switch to a fresh vault: the SAME bridge lands there, the app's identity
  // is ensured on first call, but no grant exists — a receipted deny.
  const work = registry.create('Work');
  registry.setActive(work.vaultId);
  const denied = await bridge(readReq);
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe('VAULT_CONSENT');

  // Switching back restores access — the grant lived in the first vault all along.
  registry.setActive(personal.vaultId);
  const restored = await bridge(readReq);
  expect(restored.ok).toBe(true);
});

test('owner routes: vault list / create / update / delete + per-vault selection', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const handler = makeVaultRouteHandler(registry);
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${addr.port}/centraid/_vault`;

  // Status names the active vault.
  const status = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
  expect(status).toMatchObject({ active: true, name: "Priya's vault" });

  // Create over HTTP; it does not steal the active seat.
  const created = (await (
    await fetch(`${base}/vaults`, { method: 'POST', body: JSON.stringify({ name: 'Family' }) })
  ).json()) as { vaultId: string; name: string; active: boolean };
  expect(created).toMatchObject({ name: 'Family', active: false });

  const listed = (await (await fetch(`${base}/vaults`)).json()) as { vaults: unknown[] };
  expect(listed.vaults).toHaveLength(2);

  // Per-vault selection: enroll an app only in the new vault, then read
  // both consent surfaces — they are disjoint.
  registry.get(created.vaultId)!.enrollApp('planner');
  const activeApps = (await (await fetch(`${base}/apps`)).json()) as { apps: unknown[] };
  expect(activeApps.apps).toHaveLength(0);
  const familyApps = (await (await fetch(`${base}/apps?vault=${created.vaultId}`)).json()) as {
    apps: Array<{ name: string }>;
  };
  expect(familyApps.apps).toMatchObject([{ name: 'planner' }]);
  const unknown = await fetch(`${base}/apps?vault=nope`);
  expect(unknown.status).toBe(404);

  // Update: rename, then activate.
  const patched = (await (
    await fetch(`${base}/vaults/${created.vaultId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Sharma family', active: true }),
    })
  ).json()) as { name: string; active: boolean };
  expect(patched).toMatchObject({ name: 'Sharma family', active: true });
  expect(registry.active().boot.vaultId).toBe(created.vaultId);

  // Delete: the active vault 409s; a parked one goes, files and all.
  const veto = await fetch(`${base}/vaults/${created.vaultId}`, { method: 'DELETE' });
  expect(veto.status).toBe(409);
  const original = registry.list().find((v) => !v.active)!;
  const gone = await fetch(`${base}/vaults/${original.vaultId}`, { method: 'DELETE' });
  expect(gone.status).toBe(200);
  expect(existsSync(path.join(root, original.vaultId))).toBe(false);
});

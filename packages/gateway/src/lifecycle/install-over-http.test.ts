import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Bundled-app install over HTTP (issue #434). "Use template" cloned a
 * blueprint into the vault's git code store; install instead registers the
 * app + grants its declared scopes and serves it in place from the shipped
 * @centraid/blueprints package — no code copy, no git. This boots a real
 * git-store gateway and drives that exact wire path: install → listing union
 * → catalog install-state → per-vault rename → uninstall (grants revoked,
 * nothing in git) → reinstall (fresh consent). `tasks` is a real bundled app
 * (kind 'app', 15 declared scopes) so the grants are load-bearing.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

function jsonAuth(): Record<string, string> {
  return { ...auth(), 'Content-Type': 'application/json' };
}

interface AppRow {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  hasIndex?: boolean;
  iconKey?: string;
  colorKey?: string;
}

async function listApps(): Promise<AppRow[]> {
  const res = await fetch(`${handle.url}/centraid/_apps`, { headers: auth() });
  return (await res.json()) as AppRow[];
}

interface VaultAppRow {
  name: string;
  status: string;
  origin: string;
  grants: { scopes: { schema: string; table?: string; verbs: string }[] }[];
}

async function vaultApps(): Promise<VaultAppRow[]> {
  const res = await fetch(`${handle.url}/centraid/_vault/apps`, { headers: auth() });
  const body = (await res.json()) as { apps: VaultAppRow[] };
  return body.apps;
}

async function install(templateId: string): Promise<Response> {
  return fetch(`${handle.url}/centraid/_apps/_install`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ templateId }),
  });
}

beforeEach(async () => {
  dataDir = await tempDir(`gw-install-${crypto.randomUUID()}-`);
  handle = await serve({ paths: pathsUnder(dataDir) });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('install registers a bundled app in place — no git, keeps its own id, grants declared scopes', async () => {
  const res = await install('tasks');
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    app: { id: string; name?: string; iconKey?: string; colorKey?: string };
    installed: boolean;
    alreadyInstalled: boolean;
  };
  // Keeps the blueprint's own id — no suggestCloneIdentityFrom minting.
  expect(body.app.id).toBe('tasks');
  expect(body.app.name).toBe('Tasks');
  expect(body.installed).toBe(true);
  expect(body.alreadyInstalled).toBe(false);

  // It surfaces in the listing union with metadata read from the shipped
  // blueprint dir (name + hasIndex prove the resolver read the package, not
  // an empty code store).
  const row = (await listApps()).find((a) => a.id === 'tasks');
  expect(row).toBeTruthy();
  expect(row!.name).toBe('Tasks');
  expect(row!.kind).toBe('app');
  expect(row!.hasIndex).toBe(true);

  // Nothing was written to the git code store — no versions exist.
  const versions = await fetch(`${handle.url}/centraid/_apps/tasks/git-versions`, {
    headers: auth(),
  });
  const vbody = (await versions.json()) as { versions: unknown[] };
  expect(vbody.versions.length).toBe(0);

  // The declared scopes were granted at install (installing IS the consent).
  const enrolled = (await vaultApps()).find((a) => a.name === 'tasks');
  expect(enrolled).toBeTruthy();
  expect(enrolled!.origin).toBe('installed');
  expect(enrolled!.status).toBe('active');
  const scopeCount = enrolled!.grants.reduce((n, g) => n + g.scopes.length, 0);
  expect(scopeCount).toBeGreaterThan(0);
});

test('install is idempotent — a second install returns the existing registration', async () => {
  const first = await install('tasks');
  expect(first.status).toBe(200);
  const second = await install('tasks');
  expect(second.status).toBe(200);
  const body = (await second.json()) as { alreadyInstalled: boolean };
  expect(body.alreadyInstalled).toBe(true);

  // Still exactly one row in the listing (no duplicate).
  const rows = (await listApps()).filter((a) => a.id === 'tasks');
  expect(rows.length).toBe(1);
});

test('unknown template id → 404', async () => {
  const res = await install('does-not-exist');
  expect(res.status).toBe(404);
});

test('the catalog reports per-vault install state', async () => {
  const before = await fetch(`${handle.url}/centraid/_templates`, { headers: auth() });
  const beforeRows = (await before.json()) as { id: string; installed?: boolean }[];
  expect(beforeRows.find((t) => t.id === 'tasks')?.installed).toBe(false);

  await install('tasks');

  const after = await fetch(`${handle.url}/centraid/_templates`, { headers: auth() });
  const afterRows = (await after.json()) as { id: string; installed?: boolean }[];
  expect(afterRows.find((t) => t.id === 'tasks')?.installed).toBe(true);
  // A non-installed bundled app still reads false.
  expect(afterRows.find((t) => t.id === 'notes')?.installed).toBe(false);
});

test('the listing is a union — installed bundled app + code-store scaffold, no duplicates', async () => {
  await install('tasks');

  // Scaffold + publish a code-store app the old way.
  const create = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ id: 'myscratch', name: 'My Scratch', publish: true }),
  });
  expect(create.status).toBe(201);

  const ids = (await listApps()).map((a) => a.id).sort();
  expect(ids).toContain('tasks'); // bundled, served in place
  expect(ids).toContain('myscratch'); // code-store
  // No id appears twice.
  expect(new Set(ids).size).toBe(ids.length);
});

test('bundled ids are reserved — scaffold and clone of a bundled id are refused', async () => {
  const scaffold = await fetch(`${handle.url}/centraid/_apps`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ id: 'tasks', name: 'Impostor', publish: true }),
  });
  expect(scaffold.status).toBe(409);

  const clone = await fetch(`${handle.url}/centraid/_apps/_clone`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ templateId: 'tasks', publish: true }),
  });
  // Clone of a bundled app is rejected (install it instead).
  expect(clone.status).toBe(409);
});

test('per-vault rename via /meta sets a label honored by the listing; blank clears it', async () => {
  await install('tasks');

  const rename = await fetch(`${handle.url}/centraid/_apps/tasks/meta`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ name: 'My To-Dos', publish: true }),
  });
  expect(rename.status).toBe(200);
  let row = (await listApps()).find((a) => a.id === 'tasks');
  expect(row!.name).toBe('My To-Dos');

  // Clearing (blank) falls back to the manifest name.
  const clear = await fetch(`${handle.url}/centraid/_apps/tasks/meta`, {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ name: '', publish: true }),
  });
  expect(clear.status).toBe(200);
  row = (await listApps()).find((a) => a.id === 'tasks');
  expect(row!.name).toBe('Tasks');
});

test('uninstall revokes grants + drops from the listing, keeps nothing in git; reinstall is fresh consent', async () => {
  await install('tasks');
  const grantsBefore = (await vaultApps())
    .find((a) => a.name === 'tasks')!
    .grants.reduce((n, g) => n + g.scopes.length, 0);
  expect(grantsBefore).toBeGreaterThan(0);

  // Uninstall — DELETE tolerates "nothing in git" and runs the revoke cascade.
  const del = await fetch(`${handle.url}/centraid/_apps/tasks`, {
    method: 'DELETE',
    headers: auth(),
  });
  expect(del.status).toBe(200);
  const delBody = (await del.json()) as { deleted: boolean; codeRemoved: boolean };
  expect(delBody.deleted).toBe(true);
  expect(delBody.codeRemoved).toBe(false); // there was never any code in git

  // Gone from the listing and no longer an active enrollment.
  expect((await listApps()).some((a) => a.id === 'tasks')).toBe(false);
  expect((await vaultApps()).some((a) => a.name === 'tasks')).toBe(false);
  const afterCat = await fetch(`${handle.url}/centraid/_templates`, { headers: auth() });
  const catRows = (await afterCat.json()) as { id: string; installed?: boolean }[];
  expect(catRows.find((t) => t.id === 'tasks')?.installed).toBe(false);

  // Reinstall — fresh consent: the declared scopes are granted again (the
  // revoke cascade cleared the tombstones).
  const re = await install('tasks');
  expect(re.status).toBe(200);
  const grantsAfter = (await vaultApps())
    .find((a) => a.name === 'tasks')!
    .grants.reduce((n, g) => n + g.scopes.length, 0);
  expect(grantsAfter).toBe(grantsBefore);
});

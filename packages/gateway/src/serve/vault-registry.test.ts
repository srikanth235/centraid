import { afterEach, expect, test, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultRegistry, VaultRegistryError, type VaultRegistry } from './vault-registry.js';
import { runWithVaultContext } from './vault-context.js';
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

test('a fresh root bootstraps one default vault in its own directory — and no pointer file', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const vaults = registry.list();
  expect(vaults).toHaveLength(1);
  expect(vaults[0]).toMatchObject({ name: "Priya's vault" });
  expect(existsSync(path.join(root, vaults[0]!.vaultId, 'vault.db'))).toBe(true);
  // Issue #289: the server-global active pointer is dead — the client owns it.
  expect(existsSync(path.join(root, 'vaults.json'))).toBe(false);
  expect(registry.defaultVaultId()).toBe(vaults[0]!.vaultId);
});

test('create / rename / delete — and the LAST vault is undeletable', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const first = registry.list()[0]!;

  const family = registry.create('Family');
  expect(family).toMatchObject({ name: 'Family' });
  expect(registry.list()).toHaveLength(2);

  const renamed = registry.rename(family.vaultId, 'Sharma family');
  expect(renamed.name).toBe('Sharma family');
  expect(() => registry.rename(family.vaultId, '   ')).toThrow(VaultRegistryError);

  registry.delete(first.vaultId);
  expect(registry.list()).toHaveLength(1);
  expect(existsSync(path.join(root, first.vaultId))).toBe(false);
  expect(registry.get(first.vaultId)).toBeUndefined();

  // A gateway always hosts at least one vault.
  expect(() => registry.delete(family.vaultId)).toThrow(VaultRegistryError);
});

test('runner cache lives OUTSIDE the vault tree (a `-cache` sibling) and is purged on delete', async () => {
  const root = await tempDir();
  const cacheRoot = path.join(path.dirname(root), `${path.basename(root)}-cache`);
  cleanups.push(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const registry = openRegistry(root);
  const first = registry.list()[0]!;

  const ws = registry.get(first.vaultId)!.workspace;
  // The runner scratch is NOT under the vault dir (journal.db is the source of
  // truth; this is disposable cache) — it's the per-vault `-cache` sibling.
  expect(ws.runnerSessionDir.startsWith(path.join(root, first.vaultId) + path.sep)).toBe(false);
  expect(ws.runnerSessionDir).toBe(path.join(cacheRoot, first.vaultId, 'runner-sessions'));

  // Deleting a vault also purges its cache dir (which the vault-dir rmSync
  // can't reach).
  const family = registry.create('Family');
  const famCache = path.join(cacheRoot, family.vaultId);
  await fs.mkdir(path.join(famCache, 'runner-sessions'), { recursive: true });
  await fs.writeFile(path.join(famCache, 'runner-sessions', 'w1.jsonl'), 'resume-state');
  expect(existsSync(famCache)).toBe(true);
  registry.delete(family.vaultId);
  expect(existsSync(famCache)).toBe(false);
});

test('the registry survives a restart: same vaults, same names', async () => {
  const root = await tempDir();
  const first = openVaultRegistry({ rootDir: root, logger: silentLogger, ownerName: 'Priya' });
  first.create('Work');
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
  expect(second.list().map((v) => v.name)).toContain('Work');
  expect(second.current().boot.fresh).toBe(false);
});

test('current() resolves per request context; grants stay per vault (issue #289)', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const personal = registry.list()[0]!;
  const work = registry.create('Work');

  registry.enrollApp('planner');
  registry.current().approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });

  const bridge = registry.bridgeFor('planner');
  const readReq = {
    op: 'read' as const,
    payload: { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  };

  // Unscoped call rides the default vault, where the grant lives.
  const allowed = await bridge(readReq);
  expect(allowed.ok).toBe(true);

  // The SAME bridge, addressed to the other vault: the app's identity is
  // ensured on first call, but no grant exists — a receipted deny.
  const denied = await runWithVaultContext({ vaultId: work.vaultId }, () => bridge(readReq));
  expect(denied.ok).toBe(false);
  expect(denied.code).toBe('VAULT_CONSENT');

  // Two "clients" on two vaults, concurrently — neither disturbs the other.
  const [a, b] = await Promise.all([
    runWithVaultContext({ vaultId: personal.vaultId }, () => bridge(readReq)),
    runWithVaultContext({ vaultId: work.vaultId }, () => bridge(readReq)),
  ]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(false);
});

test('a vault created out of band (admin CLI) mounts on first lookup', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);

  // Second process (the admin CLI) creates a vault in the same root.
  const cli = openVaultRegistry({ rootDir: root, logger: silentLogger, ownerName: 'Priya' });
  const fresh = cli.create('Guest');
  cli.stop();

  // The running registry picks it up on the miss — no restart.
  expect(registry.get(fresh.vaultId)?.name).toBe('Guest');
  expect(registry.list().map((v) => v.vaultId)).toContain(fresh.vaultId);
});

test('late-mount listeners observe out-of-band mounts and can unsubscribe', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const mounted: string[] = [];
  const unsubscribe = registry.onMount((plane) => mounted.push(plane.boot.vaultId));

  const cli = openVaultRegistry({ rootDir: root, logger: silentLogger, ownerName: 'Priya' });
  const fresh = cli.create('Recovered');
  cli.stop();
  expect(registry.get(fresh.vaultId)).toBeDefined();
  expect(mounted).toEqual([fresh.vaultId]);

  unsubscribe();
  registry.create('After unsubscribe');
  expect(mounted).toEqual([fresh.vaultId]);
});

test('owner routes: list + rename/presentation; create/delete are admin-plane (405)', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const handler = makeVaultRouteHandler(registry);
  const server = http.createServer((req, res) => {
    // Stand-in for the composed handler: scope each request to the vault
    // named by the addressing header, default vault otherwise.
    const requested = req.headers['x-centraid-vault'];
    const vaultId = typeof requested === 'string' ? requested : registry.defaultVaultId();
    void runWithVaultContext({ vaultId }, () => handler(req, res)).then((owned) => {
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

  // Status names the request's vault.
  const status = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
  expect(status).toMatchObject({ name: "Priya's vault" });

  // Vault create left the HTTP surface (#289): admin plane only.
  const created = await fetch(`${base}/vaults`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Family' }),
  });
  expect(created.status).toBe(405);

  // The admin creates one out of band; the list shows it.
  const family = registry.create('Family');
  const listed = (await (await fetch(`${base}/vaults`)).json()) as { vaults: unknown[] };
  expect(listed.vaults).toHaveLength(2);

  // Per-vault addressing: enroll an app only in the new vault, then read
  // both consent surfaces — they are disjoint.
  registry.get(family.vaultId)!.enrollApp('planner');
  const defaultApps = (await (await fetch(`${base}/apps`)).json()) as { apps: unknown[] };
  expect(defaultApps.apps).toHaveLength(0);
  const familyApps = (await (
    await fetch(`${base}/apps`, { headers: { 'x-centraid-vault': family.vaultId } })
  ).json()) as { apps: Array<{ name: string }> };
  expect(familyApps.apps).toMatchObject([{ name: 'planner' }]);

  // Rename + presentation ride PATCH; activation is not a server concept.
  const patched = (await (
    await fetch(`${base}/vaults/${family.vaultId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Sharma family', color: '#aa3355' }),
    })
  ).json()) as { name: string; color?: string };
  expect(patched).toMatchObject({ name: 'Sharma family', color: '#aa3355' });

  // Vault delete left the HTTP surface too.
  const veto = await fetch(`${base}/vaults/${family.vaultId}`, { method: 'DELETE' });
  expect(veto.status).toBe(405);
  expect(registry.list()).toHaveLength(2);
});

// Issue #351: a corrupt vault used to vanish silently — `scannedDirs` marked
// it as handled BEFORE the mount attempt, so a directory that failed to
// open was never retried until process restart. These pin the fix: the
// failure is recorded, retried (with backoff) on a later `scan()`, and
// cleared once the directory becomes mountable.
test('a directory that fails to mount is recorded in failedMounts, retried on a later scan (past backoff), and cleared once mountable', async () => {
  vi.useFakeTimers();
  try {
    const root = await tempDir();
    const donorRoot = await tempDir();

    // A directory with a `vault.db` that isn't a valid SQLite file at all —
    // the cheapest reliable way to make `openVaultDb` throw.
    const badDir = path.join(root, 'badvault');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'vault.db'), 'not a sqlite file');

    // A donor vault, bootstrapped through the real registry so its
    // vault.db/journal.db are genuinely valid and carry their own vaultId
    // (never mounted in the registry under test, so no id collision below).
    const donor = openVaultRegistry({
      rootDir: donorRoot,
      logger: silentLogger,
      ownerName: 'Donor',
    });
    const donorVaultId = donor.list()[0]!.vaultId;
    donor.stop();

    const registry = openRegistry(root);

    // Construction's initial scan() tried badvault, failed, and — unlike
    // before the fix — did NOT permanently swallow it.
    let failed = registry.failedMounts();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ dir: badDir });
    expect(failed[0]!.message.length).toBeGreaterThan(0);
    const firstAttemptAt = failed[0]!.at;
    // The auto-created default vault is the only mounted one so far.
    expect(registry.list()).toHaveLength(1);

    // Immediately rescanning stays within the backoff window — badvault is
    // still corrupt, but this also proves a naive fix (retry unconditionally
    // on every scan) isn't what's under test: the failure record is
    // untouched, not refreshed, because the attempt is skipped.
    registry.rescan();
    expect(registry.failedMounts()).toEqual(failed);

    // The directory becomes mountable (an operator replaced the corrupt
    // file, or — as simulated here — a valid pair of DB files lands there).
    await fs.copyFile(
      path.join(donorRoot, donorVaultId, 'vault.db'),
      path.join(badDir, 'vault.db'),
    );
    await fs.copyFile(
      path.join(donorRoot, donorVaultId, 'journal.db'),
      path.join(badDir, 'journal.db'),
    );

    // Past the backoff window, the next scan retries it.
    vi.advanceTimersByTime(31_000);
    registry.rescan();

    failed = registry.failedMounts();
    expect(failed).toHaveLength(0);
    const mounted = registry.list().map((v) => v.vaultId);
    expect(mounted).toHaveLength(2);
    expect(mounted).toContain(donorVaultId);
    expect(firstAttemptAt).not.toBe(undefined); // sanity: we did capture a timestamp above
  } finally {
    vi.useRealTimers();
  }
});

// Issue #439 R1: the live-gateway adopt seam. `recover()` renames a restored
// staging dir into `<root>/<vaultId>`; the running gateway then `adopt()`s it —
// mounting it and dropping the pristine default the registry bootstrapped onto
// the (previously empty) blank machine, so the recovered vault stands alone.
test('adopt() mounts a recovered vault dir and removes the pristine auto-created default', async () => {
  // A "recovered" vault, produced by a real registry in a donor root (older id
  // than the blank machine's auto-default, exactly as a real recovery would be),
  // then stopped so its files are consistent to copy.
  const donorRoot = await tempDir();
  const donor = openVaultRegistry({ rootDir: donorRoot, logger: silentLogger, ownerName: 'Mara' });
  const recoveredId = donor.list()[0]!.vaultId;
  donor.rename(recoveredId, 'Recovered');
  donor.stop();

  // The blank machine bootstraps its own pristine default onto an empty root.
  const root = await tempDir();
  const registry = openRegistry(root);
  const pristine = registry.list()[0]!;
  expect(registry.list()).toHaveLength(1);

  // recover() renamed the restored dir into place; simulate that with a copy.
  await fs.cp(path.join(donorRoot, recoveredId), path.join(root, recoveredId), { recursive: true });
  const donorKey = path.join(donorRoot, 'keys', `${recoveredId}.sealkey`);
  if (existsSync(donorKey)) {
    await fs.mkdir(path.join(root, 'keys'), { recursive: true });
    await fs.cp(donorKey, path.join(root, 'keys', `${recoveredId}.sealkey`));
  }

  const adopted = registry.adopt(recoveredId);

  expect(adopted.vaultId).toBe(recoveredId);
  expect(adopted.name).toBe('Recovered');
  // The pristine default is gone; the recovered vault stands alone and is the
  // effective default.
  expect(registry.list().map((v) => v.vaultId)).toEqual([recoveredId]);
  expect(registry.defaultVaultId()).toBe(recoveredId);
  expect(existsSync(path.join(root, pristine.vaultId))).toBe(false);
});

test('a directory whose vault.db duplicates an already-mounted vault id is recorded in failedMounts too', async () => {
  const root = await tempDir();
  const registry = openRegistry(root);
  const first = registry.list()[0]!;
  const firstDir = path.join(root, first.vaultId);

  // Clone the mounted vault's files into a second directory — same
  // vaultId, so it can never cleanly mount alongside the original. The
  // `-wal` siblings are part of the clone: with `wal_autocheckpoint = 0`
  // (issue #408 — only the WAL shipper checkpoints), a live vault's recent
  // writes live in the WAL until the next shipper checkpoint, so a bare
  // `vault.db` copy would be an EMPTY database that bootstraps fresh under
  // a new id instead of colliding.
  const dupeDir = path.join(root, 'dupe-of-first');
  await fs.mkdir(dupeDir, { recursive: true });
  for (const name of ['vault.db', 'journal.db', 'vault.db-wal', 'journal.db-wal']) {
    await fs.copyFile(path.join(firstDir, name), path.join(dupeDir, name)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  registry.rescan();

  const failed = registry.failedMounts();
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ dir: dupeDir });
  expect(failed[0]!.message).toContain(first.vaultId);
  expect(registry.list()).toHaveLength(1);
});

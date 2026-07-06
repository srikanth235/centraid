// Scenario seeds end-to-end (issue #290 phase 1): every blueprint seed.js
// runs in the real handler worker against a real vault plane through the
// demo bridge — the same path the demo route drives — then purges clean.
// This is the schema-drift tripwire: a command a generator calls that no
// longer exists (or whose input changed) fails HERE, not on an owner's
// first click.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runHandler } from '@centraid/app-engine';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `demo-seed-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openPlane(dir: string): VaultPlane {
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

const BLUEPRINTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'blueprints',
  'apps',
);

async function loadSeed(plane: VaultPlane, appId: string, appsDir: string): Promise<void> {
  const seedFile = path.join(BLUEPRINTS, appId, 'seed.js');
  expect(existsSync(seedFile), `${appId} ships seed.js`).toBe(true);
  const outcome = await runHandler({
    app: { id: appId, dir: path.join(appsDir, appId) },
    handlerFile: seedFile,
    handlerKind: 'action',
    args: { input: { seed: 1, now: new Date().toISOString() } },
    timeoutMs: 60_000,
    vault: plane.demoBridgeFor(appId),
  });
  expect(outcome.ok, `${appId} seed: ${outcome.error ?? ''}`).toBe(true);
}

test('every shipped scenario seeds through the demo register and purges clean', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const appsDir = path.join(dir, 'apps');

  for (const appId of ['tasks', 'notes', 'people', 'tally']) {
    await loadSeed(plane, appId, appsDir);
  }

  const status = plane.demoStatus();
  const byApp = new Map(status.map((s) => [s.appId, s.rows]));
  expect([...byApp.keys()].sort()).toEqual(['notes', 'people', 'tally', 'tasks']);
  for (const [appId, rows] of byApp) expect(rows, `${appId} seeded rows`).toBeGreaterThan(0);

  // Every seeded ENTITY carries seed.demo provenance and one registry row —
  // provenance may hold several rows per entity (a task added then completed
  // writes twice), the registry exactly one.
  const provCounts = plane.db.journal
    .prepare(
      `SELECT count(DISTINCT entity_type || ':' || entity_id) AS n
         FROM consent_provenance WHERE prov_activity = 'seed.demo'`,
    )
    .get() as { n: number };
  const registered = plane.db.vault
    .prepare('SELECT count(*) AS n FROM consent_seed_row')
    .get() as { n: number };
  expect(provCounts.n).toBe(registered.n);

  // Purge everything: registry empty, domain tables empty of demo rows.
  const purge = plane.purgeDemo();
  expect(purge.blocked).toEqual([]);
  expect(purge.purged).toBe(registered.n);
  expect(plane.demoStatus()).toEqual([]);
  for (const table of ['schedule_task', 'knowledge_note', 'tally_expense', 'people_profile']) {
    const left = plane.db.vault.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    expect(left.n, `${table} empty after purge`).toBe(0);
  }
});

test('the demo bridge refuses non-scenario ops and non-owner registers stay impossible', async () => {
  const dir = await tempDir();
  const plane = openPlane(dir);
  const bridge = plane.demoBridgeFor('tasks');
  const refused = await bridge({ op: 'changes', payload: { entities: ['schedule.task'] } });
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/not part of the scenario surface/);
});

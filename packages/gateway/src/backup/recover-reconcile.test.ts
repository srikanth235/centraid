/*
 * Adopt-time inventory reconcile (issue #439 R5) — the four outcomes, in
 * isolation: a restored `blob_replica` index of beliefs, a provider inventory
 * that is truth, an injected `materialize` standing in for the engine's blob
 * re-pin, and the assertions that (a) a snapshot-carried missing blob is
 * re-pinned and unmarked, (b) a snapshot-less missing blob is LOST and unmarked,
 * (c) no inventory ⇒ honest skip with the index untouched, (d) full agreement ⇒
 * a clean report.
 */

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FsBlobStore, ReplicaIndex } from '@centraid/vault';
import { reconcileAdoptedInventory } from './recover-reconcile.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sha = (seed: string): string => crypto.createHash('sha256').update(seed).digest('hex');
const manifestPath = (s: string): string => `blobs/sha256/${s.slice(0, 2)}/${s}`;

/** A minimal vault dir: a `vault.db` carrying just `blob_replica` (all the
 *  reconcile reads) with the given shas marked 'cas'-durable, plus a `blobs/` store. */
async function makeVault(believedCas: string[]): Promise<{ dir: string; blobs: FsBlobStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `reconcile-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'vault.db'));
  db.exec(`CREATE TABLE blob_replica (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    replicated_at TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    store TEXT NOT NULL DEFAULT 'cas' CHECK (store IN ('cas','derived'))
  ) STRICT;`);
  const index = new ReplicaIndex(db);
  for (const s of believedCas) index.mark(s, 100, 'cas');
  db.close();
  return { dir, blobs: new FsBlobStore(path.join(dir, 'blobs')) };
}

/** Read back which shas `blob_replica` still believes 'cas'-durable. */
function believedAfter(dir: string): Set<string> {
  const db = new DatabaseSync(path.join(dir, 'vault.db'), { readOnly: true });
  try {
    return new ReplicaIndex(db).all('cas');
  } finally {
    db.close();
  }
}

function spyLogger(): {
  error: string[];
  warn: string[];
  info: string[];
  log: Record<string, (m: string) => void>;
} {
  const error: string[] = [];
  const warn: string[] = [];
  const info: string[] = [];
  return {
    error,
    warn,
    info,
    log: { error: (m) => error.push(m), warn: (m) => warn.push(m), info: (m) => info.push(m) },
  };
}

test('(a) a missing blob the snapshot carries is re-pinned, unmarked, and reported', async () => {
  const kept = sha('kept'); // still on the provider
  const dropped = sha('dropped'); // the provider lost it; the snapshot carries it
  const { dir, blobs } = await makeVault([kept, dropped]);
  const spy = spyLogger();
  let fetched: string[] = [];

  const report = await reconcileAdoptedInventory({
    vaultDir: dir,
    remoteShas: new Set([kept]), // dropped is NOT held anymore
    snapshotEntries: [manifestPath(kept), manifestPath(dropped), 'vault.db'],
    materialize: async (shas) => {
      fetched = shas;
      for (const s of shas) blobs.putSync(s, Buffer.from(`bytes-${s}`)); // the engine's re-pin
      return shas;
    },
    log: spy.log,
  });

  expect(report).toMatchObject({ checked: 2, missing: 1, repinned: [dropped], lost: [] });
  expect(report.skipped).toBeUndefined();
  expect(fetched).toEqual([dropped]); // the reconcile asked the engine for exactly the gap
  expect(blobs.hasSync(dropped)).toBe(true); // it is local again
  // The stale belief is gone; the kept one survives.
  const believed = believedAfter(dir);
  expect(believed.has(dropped)).toBe(false);
  expect(believed.has(kept)).toBe(true);
  expect(spy.warn.some((m) => /re-pinned/.test(m))).toBe(true);
  expect(spy.error).toHaveLength(0);
});

test('(b) a missing blob the snapshot does NOT carry is LOST, unmarked, and CRITICAL', async () => {
  const lost = sha('direct-cas-only'); // a direct-to-CAS original, not in the snapshot
  const { dir } = await makeVault([lost]);
  const spy = spyLogger();
  let materializeCalls = 0;

  const report = await reconcileAdoptedInventory({
    vaultDir: dir,
    remoteShas: new Set(), // the provider holds nothing
    snapshotEntries: ['vault.db', 'journal.db'], // snapshot carries NO blobs
    materialize: async (shas) => {
      materializeCalls++;
      return shas;
    },
    log: spy.log,
  });

  expect(report).toMatchObject({ checked: 1, missing: 1, repinned: [], lost: [lost] });
  expect(materializeCalls).toBe(0); // nothing to re-pin — the snapshot can't help
  expect(believedAfter(dir).has(lost)).toBe(false); // still unmarked (stop trusting a dead remote)
  expect(spy.error.some((m) => /CRITICAL/.test(m) && /LOST/.test(m))).toBe(true);
});

test('(c) a provider with no inventory capability skips honestly and touches nothing', async () => {
  const believed = sha('believed');
  const { dir } = await makeVault([believed]);
  const spy = spyLogger();

  const report = await reconcileAdoptedInventory({
    vaultDir: dir,
    remoteShas: undefined, // no `inventory` capability
    snapshotEntries: [manifestPath(believed)],
    materialize: async () => {
      throw new Error('materialize must not run when there is nothing to reconcile against');
    },
    log: spy.log,
  });

  expect(report).toEqual({
    checked: 0,
    missing: 0,
    repinned: [],
    lost: [],
    skipped: 'no-inventory-capability',
  });
  expect(believedAfter(dir).has(believed)).toBe(true); // index left exactly as restored
  expect(spy.error).toHaveLength(0);
});

test('(d) full agreement between the index and the inventory is a clean report', async () => {
  const a = sha('a');
  const b = sha('b');
  const { dir } = await makeVault([a, b]);
  const spy = spyLogger();

  const report = await reconcileAdoptedInventory({
    vaultDir: dir,
    remoteShas: new Set([a, b]), // provider holds everything the index believes
    snapshotEntries: [manifestPath(a), manifestPath(b)],
    materialize: async () => {
      throw new Error('materialize must not run when nothing is missing');
    },
    log: spy.log,
  });

  expect(report).toEqual({ checked: 2, missing: 0, repinned: [], lost: [] });
  expect(believedAfter(dir)).toEqual(new Set([a, b])); // nothing unmarked
  expect(spy.error).toHaveLength(0);
  expect(spy.warn).toHaveLength(0);
});

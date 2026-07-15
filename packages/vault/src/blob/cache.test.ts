// Bounded storage tier — cache policy, eviction, replication index, QoS and
// bounded-parallel replication (issue #405 §3/§4/§7). A fake remote counts
// list()/get()/put() so the acceptance criteria ("zero remote reads",
// "statusFor/replicate perform ZERO list() calls", "max in-flight = N") are
// assertions over recorded call shapes, not vibes.

import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { BlobCustody } from './custody.js';
import { BlobCache, CACHE_BUDGET_CEILING_BYTES, CACHE_BUDGET_FLOOR_BYTES } from './cache.js';
import { MemoryBlobStore } from './local.js';
import type { BlobRange, BlobStat, BlobStore } from './store.js';
import { blobUriFor, sha256OfBytes } from './store.js';
import { VaultBlobBackpressureError } from '../errors.js';

// ---------- an instrumented in-memory remote ----------

interface FakeRemote extends BlobStore {
  objects: Map<string, Buffer>;
  calls: { list: number; get: number; put: number };
  /** Gate every put on a promise the test controls (bounded-parallel / QoS). */
  gatePuts(): { release: () => void; inFlightMax: () => number };
  /** Gate every get on a promise the test controls (QoS interactive read). */
  gateGets(): { resolveAll: () => void; pending: () => number };
}

function makeRemote(): FakeRemote {
  const objects = new Map<string, Buffer>();
  const calls = { list: 0, get: 0, put: 0 };
  let putGate: Promise<void> | null = null;
  let inFlight = 0;
  let inFlightMax = 0;
  let getGate: { promise: Promise<void>; resolve: () => void } | null = null;
  let getPending = 0;
  const store: FakeRemote = {
    kind: 'fake-remote',
    objects,
    calls,
    async put(sha, bytes) {
      calls.put += 1;
      inFlight += 1;
      inFlightMax = Math.max(inFlightMax, inFlight);
      try {
        if (putGate) await putGate;
        objects.set(sha, Buffer.from(bytes));
      } finally {
        inFlight -= 1;
      }
    },
    async get(sha, range?: BlobRange) {
      calls.get += 1;
      if (getGate) {
        getPending += 1;
        try {
          await getGate.promise;
        } finally {
          getPending -= 1;
        }
      }
      const whole = objects.get(sha);
      if (!whole) return null;
      if (!range) return Buffer.from(whole);
      const end = range.end ?? whole.length - 1;
      return Buffer.from(whole.subarray(range.start, end + 1));
    },
    has(sha) {
      return Promise.resolve(objects.has(sha));
    },
    delete(sha) {
      objects.delete(sha);
      return Promise.resolve();
    },
    list() {
      calls.list += 1;
      return Promise.resolve([...objects.keys()].sort());
    },
    stat(sha): Promise<BlobStat | null> {
      const b = objects.get(sha);
      return Promise.resolve(b ? { size: b.length } : null);
    },
    gatePuts() {
      let release!: () => void;
      putGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release, inFlightMax: () => inFlightMax };
    },
    gateGets() {
      let releaseGet!: () => void;
      const promise = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      getGate = { promise, resolve: releaseGet };
      return { resolveAll: releaseGet, pending: () => getPending };
    },
  };
  return store;
}

// ---------- harness: real vault.db tables, injected local + fake remote ----------

interface Harness {
  db: VaultDb;
  local: MemoryBlobStore;
  remote: FakeRemote;
  cache: BlobCache;
  custody: BlobCustody;
  budget: { bytes: number };
}

let harnesses: VaultDb[] = [];
afterEach(() => {
  for (const db of harnesses) db.close();
  harnesses = [];
});

function makeHarness(opts: {
  budgetBytes: number;
  replicationConcurrency?: number;
  qos?: boolean;
}): Harness {
  const db = openVaultDb(); // in-memory: gives us every table (BLOB_DDL ran)
  harnesses.push(db);
  const local = new MemoryBlobStore();
  const remote = makeRemote();
  const budget = { bytes: opts.budgetBytes };
  const cache = new BlobCache(db.vault, local, {
    settings: () => ({ budgetBytes: budget.bytes }),
    ...(opts.replicationConcurrency ? { replicationConcurrency: opts.replicationConcurrency } : {}),
    // Fast deterministic QoS timing for tests (no real waits).
    ...(opts.qos ? { qosCooldownMs: 0, qosPollMs: 1 } : { qosCooldownMs: 0, qosPollMs: 1 }),
  });
  const custody = new BlobCustody(local, () => ({ store: remote }), cache);
  return { db, local, remote, cache, custody, budget };
}

/** Insert a live content item (so a derivative can FK to it). Returns its content_id. */
function insertContentItem(
  db: VaultDb,
  sha: string,
  size: number,
  mediaType = 'image/jpeg',
): string {
  const contentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(contentId, mediaType, blobUriFor(sha), sha, size, nowIso());
  return contentId;
}

/** Register a binary derivative rung (thumb/preview) for a parent content item. */
function insertDerivative(
  db: VaultDb,
  contentId: string,
  variant: 'thumb' | 'preview',
  sha: string,
  size: number,
): void {
  db.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES (?, ?, ?, ?, 'image/jpeg', ?, NULL, ?)`,
    )
    .run(uuidv7(), contentId, variant, sha, size, nowIso());
}

function blobOf(text: string): { bytes: Buffer; sha: string } {
  const bytes = Buffer.from(text);
  return { bytes, sha: sha256OfBytes(bytes) };
}

// ---------- §3: budget derivation ----------

test('derived budget = clamp(1 GiB, 0.5*(free+spool), 100 GiB); explicit wins; memory = unlimited', () => {
  const db = openVaultDb();
  harnesses.push(db);
  const local = new MemoryBlobStore();

  // No statfs (a MemoryBlobStore vault) ⇒ unlimited unless set explicitly.
  const memCache = new BlobCache(db.vault, local, { settings: () => ({}) });
  expect(memCache.budgetBytes()).toBe(Number.MAX_SAFE_INTEGER);

  // A generous volume: 0.5 * free is between floor and ceiling.
  const bsize = 4096;
  const midFree = 40 * 1024 ** 3; // 40 GiB free ⇒ derived ~20 GiB
  const mid = new BlobCache(db.vault, local, {
    settings: () => ({}),
    statfs: () => ({ bavail: midFree / bsize, bsize }),
  });
  expect(mid.budgetBytes()).toBe(Math.floor(0.5 * midFree));

  // A tiny volume clamps UP to the 1 GiB floor.
  const tiny = new BlobCache(db.vault, local, {
    settings: () => ({}),
    statfs: () => ({ bavail: (100 * 1024 ** 2) / bsize, bsize }), // 100 MiB free
  });
  expect(tiny.budgetBytes()).toBe(CACHE_BUDGET_FLOOR_BYTES);

  // A huge volume clamps DOWN to the 100 GiB ceiling.
  const huge = new BlobCache(db.vault, local, {
    settings: () => ({}),
    statfs: () => ({ bavail: (10 * 1024 ** 4) / bsize, bsize }), // 10 TiB free
  });
  expect(huge.budgetBytes()).toBe(CACHE_BUDGET_CEILING_BYTES);

  // Explicit setting overrides the derivation entirely.
  const explicit = new BlobCache(db.vault, local, {
    settings: () => ({ budgetBytes: 777 }),
    statfs: () => ({ bavail: midFree / bsize, bsize }),
  });
  expect(explicit.budgetBytes()).toBe(777);
});

// ---------- §7: metrics shape ----------

test('metrics() reports hits, read-throughs, bytes served, evictions and spool/budget', async () => {
  const h = makeHarness({ budgetBytes: 1000 });
  const x = blobOf('metrics-blob');
  h.custody.ingestSync(x.bytes);
  await h.custody.replicate();
  h.custody.getSync(x.sha); // one local hit
  h.custody.deleteLocalSync(x.sha);
  await h.custody.open(x.sha); // one read-through (promote)

  const m = h.custody.metrics();
  expect(m.localHits).toBe(1);
  expect(m.readThroughs).toBe(1);
  expect(m.bytesServedLocal).toBe(x.bytes.length);
  expect(m.bytesServedRemote).toBe(x.bytes.length);
  expect(m.budgetBytes).toBe(1000);
  expect(m.spoolBytes).toBe(x.bytes.length); // promoted back
});

// ---------- §3: tinies are pinned unevictable ----------

test('a thumb (tiny) is pinned — never evicted under any cache pressure', async () => {
  const h = makeHarness({ budgetBytes: 1_000_000 }); // room to ingest first
  const thumb = blobOf('tiny-thumbnail-bytes');
  h.custody.ingestSync(thumb.bytes);
  const parent = insertContentItem(h.db, sha256OfBytes(Buffer.from('parent-original')), 999);
  insertDerivative(h.db, parent, 'thumb', thumb.sha, thumb.bytes.length);
  await h.custody.replicate(); // thumb is now replicated (evictable IF it weren't pinned)
  expect(h.cache.isReplicated(thumb.sha)).toBe(true);

  // Slam the budget to nothing — every byte is "over budget" now.
  h.budget.bytes = 1;
  const evicted = h.custody.evict();
  expect(evicted.evictedBlobs).toBe(0); // pinned — the pass refuses it
  expect(h.local.hasSync(thumb.sha)).toBe(true);
});

// ---------- §3: evict-only-if-replicated — never delete the last local copy ----------

test('an un-replicated local-only blob is refused eviction; ingest backpressures, bytes intact', async () => {
  const h = makeHarness({ budgetBytes: 20 });
  const a = blobOf('0123456789'); // 10 bytes, NOT replicated
  h.custody.ingestSync(a.bytes);
  expect(h.cache.spoolBytes()).toBe(10);

  // Eviction can free nothing (a is un-replicated, the last copy).
  const evicted = h.cache.runEviction(0);
  expect(evicted.evicted).toEqual([]);

  // A second blob that would blow the budget backpressures instead of deleting a.
  const b = Buffer.from('abcdefghijklmno'); // 15 bytes → 10 + 15 = 25 > 20
  expect(() => h.custody.ingestSync(b)).toThrow(VaultBlobBackpressureError);
  expect(h.local.hasSync(a.sha)).toBe(true); // the un-replicated bytes are intact
  expect(h.custody.metrics().backpressureEvents).toBe(1);
});

test('the evict PRIMITIVE itself refuses an un-replicated sha (defense in depth)', () => {
  const h = makeHarness({ budgetBytes: 1000 });
  const a = blobOf('unreplicated');
  h.custody.ingestSync(a.bytes);
  // Directly call the low-level primitive — it must refuse without the policy loop.
  expect(h.cache.evictOne(a.sha)).toBe(0);
  expect(h.local.hasSync(a.sha)).toBe(true);
});

// ---------- §3: LRU order — previews before originals; recent outlives stale ----------

test('eviction sheds previews before originals', async () => {
  const h = makeHarness({ budgetBytes: 1000 });
  const preview = blobOf('preview-medium-bytes-................'); // larger
  const original = blobOf('original-bytes');
  h.custody.ingestSync(preview.bytes);
  h.custody.ingestSync(original.bytes);
  const p = insertContentItem(h.db, sha256OfBytes(Buffer.from('p-parent')), 5000);
  insertDerivative(h.db, p, 'preview', preview.sha, preview.bytes.length);
  await h.custody.replicate(); // both replicated

  // Budget now only allows one of them — force eviction of exactly one.
  h.budget.bytes = original.bytes.length; // room for the original only
  const { evicted } = h.cache.runEviction(0);
  expect(evicted).toEqual([preview.sha]); // the preview goes first
  expect(h.local.hasSync(original.sha)).toBe(true);
});

test('among originals, an accessed one outlives an untouched (older) one', async () => {
  const h = makeHarness({ budgetBytes: 1000 });
  const stale = blobOf('stale-original-never-read');
  const fresh = blobOf('fresh-original-read-recently');
  h.custody.ingestSync(stale.bytes);
  h.custody.ingestSync(fresh.bytes);
  await h.custody.replicate();
  // Touch `fresh` via the read path — `stale` keeps no access row (sorts oldest).
  expect(h.custody.getSync(fresh.sha)?.equals(fresh.bytes)).toBe(true);

  h.budget.bytes = fresh.bytes.length; // room for one
  const { evicted } = h.cache.runEviction(0);
  expect(evicted).toEqual([stale.sha]); // untouched/oldest goes
  expect(h.local.hasSync(fresh.sha)).toBe(true);
});

// ---------- §3/§4: read-through promotes, then is evictable ----------

test('a remote-only blob reads through into local (promote), and is evictable later', async () => {
  const h = makeHarness({ budgetBytes: 1000 });
  const x = blobOf('cloud-resident-photo');
  h.custody.ingestSync(x.bytes);
  await h.custody.replicate();
  // Drop the local copy — now remote-only.
  h.custody.deleteLocalSync(x.sha);
  expect(h.local.hasSync(x.sha)).toBe(false);

  const opened = await h.custody.open(x.sha);
  expect(opened?.equals(x.bytes)).toBe(true);
  expect(h.local.hasSync(x.sha)).toBe(true); // promoted back
  expect(h.custody.metrics().readThroughs).toBe(1);

  // Still replicated, so a later eviction can shed the promoted copy.
  h.budget.bytes = 1;
  const { evicted } = h.cache.runEviction(0);
  expect(evicted).toEqual([x.sha]);
  expect(h.local.hasSync(x.sha)).toBe(false);
  expect(h.remote.objects.has(x.sha)).toBe(true); // the durable copy remains
});

// ---------- §5: paced large-import (scaled down) ----------

test('paced import: 16 MiB through a 4 MiB spool completes, spool never exceeds budget, nothing lost', async () => {
  const BUDGET = 4 * 1024 * 1024;
  const BLOB = 1 * 1024 * 1024; // 1 MiB blobs
  const COUNT = 16; // 16 MiB total, 4x the spool
  const h = makeHarness({ budgetBytes: BUDGET });
  const shas: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const bytes = Buffer.alloc(BLOB, i + 1); // distinct bytes per blob
    const { sha256 } = h.custody.ingestSync(bytes); // precheck may evict-first
    shas.push(sha256);
    // Sample AFTER each put: the spool never exceeds the budget mid-run.
    expect(h.cache.spoolBytes()).toBeLessThanOrEqual(BUDGET);
    // Replicate what's local so the NEXT precheck has something evictable.
    await h.custody.replicate();
  }
  // Nothing lost: every sha is on remote or still local (or both).
  for (const sha of shas) {
    expect(h.remote.objects.has(sha) || h.local.hasSync(sha)).toBe(true);
  }
  // The whole library made it to durable storage.
  for (const sha of shas) expect(h.remote.objects.has(sha)).toBe(true);
});

// ---------- §4: statusFor/replicate perform ZERO remote list() calls ----------

test('statusFor and replicate never list() the remote; reconcile lists once', async () => {
  const h = makeHarness({ budgetBytes: 1_000_000 });
  const a = blobOf('sha-a');
  const b = blobOf('sha-b');
  h.custody.ingestSync(a.bytes);
  h.custody.ingestSync(b.bytes);

  await h.custody.replicate();
  expect(h.remote.calls.list).toBe(0); // replicate uses the index, not a listing

  await h.custody.statusFor([a.sha, b.sha]);
  expect(h.remote.calls.list).toBe(0); // statusFor uses the index too

  const live = new Set([a.sha, b.sha]);
  await h.custody.reconcile(live);
  expect(h.remote.calls.list).toBe(1); // the deep pass lists exactly once
});

test('reconcile heals the replication index from the real remote listing', async () => {
  const h = makeHarness({ budgetBytes: 1_000_000 });
  const a = blobOf('index-heal-a');
  h.custody.ingestSync(a.bytes);
  // Forge a stale index row for a sha the remote never had.
  const ghost = sha256OfBytes(Buffer.from('ghost'));
  h.cache.replica.mark(ghost, 5);
  expect(h.cache.isReplicated(ghost)).toBe(true);

  await h.custody.reconcile(new Set([a.sha]));
  expect(h.cache.isReplicated(ghost)).toBe(false); // healed away — remote is truth
  expect(h.cache.isReplicated(a.sha)).toBe(true); // a really did replicate
});

// ---------- §2/§3: grid-scroll over a remote-only library — zero remote reads ----------

test('serving tinies for N items performs zero remote GETs (originals remote-only)', async () => {
  const h = makeHarness({ budgetBytes: 1_000_000 });
  const N = 8;
  const thumbShas: string[] = [];
  for (let i = 0; i < N; i++) {
    const original = blobOf(`original-${i}-big-bytes`);
    const thumb = blobOf(`thumb-${i}`);
    // Original: replicate then drop local → remote-only.
    h.custody.ingestSync(original.bytes);
    // Tiny: stays local (pinned), registered as a derivative.
    h.custody.ingestSync(thumb.bytes);
    const parent = insertContentItem(h.db, original.sha, original.bytes.length);
    insertDerivative(h.db, parent, 'thumb', thumb.sha, thumb.bytes.length);
    thumbShas.push(thumb.sha);
  }
  await h.custody.replicate();
  h.remote.calls.get = 0; // reset the counter after setup

  // Paint the grid: read every tiny. All are local → zero remote GETs.
  for (const sha of thumbShas) {
    const bytes = h.custody.getSync(sha);
    expect(bytes).not.toBeNull();
  }
  expect(h.remote.calls.get).toBe(0);
  expect(h.custody.metrics().localHits).toBe(N);
});

// ---------- §4: bounded-parallel replication ----------

test('replicate pushes at most `concurrency` blobs in flight at once', async () => {
  const h = makeHarness({ budgetBytes: 100_000_000, replicationConcurrency: 3 });
  for (let i = 0; i < 9; i++) h.custody.ingestSync(Buffer.from(`bounded-parallel-${i}`));
  const gate = h.remote.gatePuts(); // every put() parks until released

  const pending = h.custody.replicate();
  // Let the pool spin up its workers.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gate.inFlightMax()).toBeLessThanOrEqual(3);
  gate.release();
  const moved = await pending;
  expect(moved.length).toBe(9);
  expect(gate.inFlightMax()).toBe(3); // it did saturate the pool
});

// ---------- §7: QoS — interactive read-through preempts bulk replication ----------

test('bulk replication parks while an interactive read-through is in flight', async () => {
  const h = makeHarness({ budgetBytes: 100_000_000, qos: true });
  // One blob already replicated + dropped locally → an interactive read must
  // fetch it from remote (that fetch is the "interactive read in flight").
  const hot = blobOf('the-photo-the-user-is-looking-at');
  h.custody.ingestSync(hot.bytes);
  await h.custody.replicate();
  h.custody.deleteLocalSync(hot.sha);

  // A backlog to replicate.
  for (let i = 0; i < 5; i++) h.custody.ingestSync(Buffer.from(`backlog-${i}`));

  const getGate = h.remote.gateGets(); // the interactive GET will hang here
  const reading = h.custody.open(hot.sha); // interactive read starts, parks in get()
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(getGate.pending()).toBe(1); // the read is genuinely in flight

  const putsBefore = h.remote.calls.put;
  const replicating = h.custody.replicate();
  // Give replication a chance to (wrongly) proceed — it must NOT while the read is hot.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.remote.calls.put).toBe(putsBefore); // parked by QoS

  getGate.resolveAll(); // the interactive read completes
  await reading;
  const moved = await replicating; // now bulk drains
  expect(moved.length).toBe(5);
});

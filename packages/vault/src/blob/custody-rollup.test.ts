// The custody rollup (#711): the arithmetic, and — the part that
// matters — the free-up safety rule. A byte with no PROVEN copy elsewhere is
// never counted as freeable, and every one of the five vetoes is exercised
// individually, because a predicate that is right for the wrong reason stops
// being right the moment someone edits it.

import { describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { updateBlobStoreSettings } from "../host.js";
import { nowIso } from "../ids.js";
import { custodyRollup, refreshCustodyRollup } from "./custody-rollup.js";
import type { CustodyState } from "./custody-types.js";
import { sha256OfBytes } from "./store.js";

function newVault(): VaultDb {
  const db = openVaultDb({});
  bootstrapVault(db, { ownerName: "Owner" });
  return db;
}

/** Declare a remote tier, which is what makes anything freeable at all. */
function setS3(db: VaultDb): void {
  updateBlobStoreSettings(db, {
    blob_store: {
      kind: "s3",
      endpoint: "https://x",
      bucket: "b",
      encrypt: true,
    },
  });
}

/**
 * A live content item plus its custody-mirror row — the two rows the rollup
 * reads. `resident` also puts the bytes in the local CAS, which is what makes
 * the sha a candidate for the local buckets at all.
 */
function addContent(
  db: VaultDb,
  options: {
    id: string;
    bytes: Buffer;
    state: CustodyState;
    resident: boolean;
  }
): string {
  const sha = sha256OfBytes(options.bytes);
  if (options.resident) db.blobs.ingestSync(options.bytes);
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/png', ?, ?, ?, ?)`
    )
    .run(options.id, `blob:sha256:${sha}`, sha, options.bytes.length, nowIso());
  db.vault
    .prepare(
      `INSERT INTO blob_custody_state (content_id, sha256, custody_state, checked_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(options.id, sha, options.state, nowIso());
  return sha;
}

/** Durable evidence that `sha` reached the remote tier under a store class. */
function markReplica(db: VaultDb, sha: string, store = "cas"): void {
  db.vault
    .prepare(
      `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store) VALUES (?, ?, 0, ?)`
    )
    .run(sha, nowIso(), store);
}

function markOutbox(db: VaultDb, sha: string): void {
  const now = nowIso();
  db.vault
    .prepare(
      `INSERT INTO blob_outbox (sha256, byte_size, created_at, updated_at) VALUES (?, 0, ?, ?)`
    )
    .run(sha, now, now);
}

describe("custody rollup arithmetic", () => {
  test("counts and bytes per custody state, zero-filled for the rest", () => {
    const db = newVault();
    addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(100, 1),
      state: "local-only",
      resident: true,
    });
    addContent(db, {
      id: "c2",
      bytes: Buffer.alloc(250, 2),
      state: "local-only",
      resident: true,
    });
    addContent(db, {
      id: "c3",
      bytes: Buffer.alloc(70, 3),
      state: "remote-only",
      resident: false,
    });

    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets["local-only"]).toStrictEqual({
      count: 2,
      bytes: 350,
    });
    expect(rollup.buckets["remote-only"]).toStrictEqual({
      count: 1,
      bytes: 70,
    });
    expect(rollup.buckets.replicated).toStrictEqual({ count: 0, bytes: 0 });
    expect(rollup.buckets.missing).toStrictEqual({ count: 0, bytes: 0 });
    db.close();
  });

  test("persists to blob_custody_rollup and reads back identically", () => {
    const db = newVault();
    addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(100, 1),
      state: "local-only",
      resident: true,
    });
    const written = refreshCustodyRollup(db);
    const read = custodyRollup(db.vault);
    expect(read.buckets).toStrictEqual(written.buckets);
    expect(read.computedAt).toBe(written.computedAt);
    db.close();
  });

  test("an unswept vault reports computedAt null, not zeroes as fact", () => {
    const db = newVault();
    const read = custodyRollup(db.vault);
    expect(read.computedAt).toBeNull();
    expect(read.buckets.freeable).toStrictEqual({ count: 0, bytes: 0 });
    db.close();
  });

  test("bytes that are not on this disk join neither local bucket", () => {
    const db = newVault();
    setS3(db);
    const sha = addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(500, 9),
      state: "remote-only",
      resident: false, // offloaded: the gateway has it, this disk does not
    });
    markReplica(db, sha);
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable).toStrictEqual({ count: 0, bytes: 0 });
    expect(rollup.buckets["local-unproven"]).toStrictEqual({
      count: 0,
      bytes: 0,
    });
    // …but it is still reported as custody, so the surface can say where it is.
    expect(rollup.buckets["remote-only"].count).toBe(1);
    db.close();
  });
});

describe("free-up safety rule: no proven copy elsewhere, never offered", () => {
  /** The one arrangement in which a byte IS freeable. Every test below breaks
   *  exactly one clause of it and asserts the offer disappears. */
  function provenlySafe(): { db: VaultDb; sha: string } {
    const db = newVault();
    setS3(db);
    const sha = addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(1000, 7),
      state: "replicated",
      resident: true,
    });
    markReplica(db, sha);
    return { db, sha };
  }

  test("the baseline: locally resident, cas-replicated, unencumbered ⇒ freeable", () => {
    const { db } = provenlySafe();
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable).toStrictEqual({ count: 1, bytes: 1000 });
    expect(rollup.buckets["local-unproven"]).toStrictEqual({
      count: 0,
      bytes: 0,
    });
    db.close();
  });

  test("no remote tier configured ⇒ the local copy is never offered", () => {
    const db = newVault(); // deliberately no setS3
    const sha = addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(1000, 7),
      state: "local-only",
      resident: true,
    });
    // Stale evidence from a tier that has since been removed must not license
    // a delete — this is the clause `blobCustodyProven` does not have.
    markReplica(db, sha);
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable).toStrictEqual({ count: 0, bytes: 0 });
    expect(rollup.buckets["local-unproven"]).toStrictEqual({
      count: 1,
      bytes: 1000,
    });
    db.close();
  });

  test("no replica evidence ⇒ not offered", () => {
    const db = newVault();
    setS3(db);
    addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(1000, 7),
      state: "local-only",
      resident: true,
    });
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable.count).toBe(0);
    expect(rollup.buckets["local-unproven"].count).toBe(1);
    db.close();
  });

  test("evidence for the DERIVED store only ⇒ not offered", () => {
    const db = newVault();
    setS3(db);
    const sha = addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(1000, 7),
      state: "replicated",
      resident: true,
    });
    markReplica(db, sha, "derived"); // a thumbnail's object, not the original's
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable.count).toBe(0);
    expect(rollup.buckets["local-unproven"].count).toBe(1);
    db.close();
  });

  test("a pending outbox obligation ⇒ not offered", () => {
    const { db, sha } = provenlySafe();
    markOutbox(db, sha); // a replacement upload is still in flight
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable.count).toBe(0);
    expect(rollup.buckets["local-unproven"].count).toBe(1);
    db.close();
  });

  test("still in staging ⇒ not offered", () => {
    const { db, sha } = provenlySafe();
    db.vault
      .prepare(
        `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, staged_at)
         VALUES ('s1', ?, 'image/png', 1000, ?)`
      )
      .run(sha, nowIso());
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable.count).toBe(0);
    expect(rollup.buckets["local-unproven"].count).toBe(1);
    db.close();
  });

  test("pinned as a browse-rung derivative ⇒ not offered", () => {
    const { db, sha } = provenlySafe();
    db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES ('d1', 'c1', 'thumb', ?, 'image/png', 10, ?)`
      )
      .run(sha, nowIso());
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable.count).toBe(0);
    expect(rollup.buckets["local-unproven"].count).toBe(1);
    db.close();
  });

  test("a mixed library offers only the proven half", () => {
    const db = newVault();
    setS3(db);
    const safe = addContent(db, {
      id: "c1",
      bytes: Buffer.alloc(400, 1),
      state: "replicated",
      resident: true,
    });
    markReplica(db, safe);
    addContent(db, {
      id: "c2",
      bytes: Buffer.alloc(600, 2),
      state: "local-only",
      resident: true,
    });
    const rollup = refreshCustodyRollup(db);
    expect(rollup.buckets.freeable).toStrictEqual({ count: 1, bytes: 400 });
    expect(rollup.buckets["local-unproven"]).toStrictEqual({
      count: 1,
      bytes: 600,
    });
    db.close();
  });
});
